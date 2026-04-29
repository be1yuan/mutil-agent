/**
 * File-based mailbox for cross-process Agent communication.
 *
 * Storage layout:
 *   {mailboxDir}/{agentType}/inbox/msg_{ts}_{rand}.json   (unread)
 *   {mailboxDir}/{agentType}/inbox/.read/msg_{ts}_{rand}.json  (read)
 *   {mailboxDir}/_dead_letter/msg_{ts}_{rand}.json  (undeliverable)
 *
 * Atomic writes: writeFile(temp) → rename(temp, target)
 * No locks needed — rename is atomic on all major filesystems.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getLogger } from "../observability/logger.js";

// ── Types ──

export interface MailMessage {
  /** Unique ID: `msg_{timestamp}_{random}` */
  id: string;
  /** Sender agentType */
  from: string;
  /** Recipient agentType or "*" for broadcast */
  to: string;
  /** Message subject */
  subject: string;
  /** Message body (Markdown) */
  body: string;
  /** Unix timestamp in ms */
  timestamp: number;
  /** Priority level */
  priority: "low" | "normal" | "high";
  /** If this is a reply, the original message ID */
  replyTo?: string;
  /** Correlation ID for request-reply pattern */
  correlationId?: string;
}

export interface MailboxStats {
  unread: number;
  read: number;
  total: number;
}

// ── Mailbox class ──

export class Mailbox {
  private pollIntervalMs: number;
  private maxAgeMs: number;

  constructor(
    private mailboxDir: string,
    opts?: { pollIntervalMs?: number; maxAgeMs?: number }
  ) {
    this.pollIntervalMs = opts?.pollIntervalMs ?? 500;
    this.maxAgeMs = opts?.maxAgeMs ?? 86_400_000;
  }

  // ── Send ──

  /**
   * Send a message. Atomic write: temp file → rename.
   * Broadcast messages (to="*") are stored in "_broadcast" directory.
   */
  async send(
    msg: Omit<MailMessage, "id" | "timestamp">
  ): Promise<MailMessage> {
    const logger = getLogger();
    const id = `msg_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const full: MailMessage = {
      ...msg,
      id,
      timestamp: Date.now(),
    };

    // "*" is not a valid directory name on Windows; use "_broadcast"
    const recipientDir = msg.to === "*" ? "_broadcast" : msg.to;

    // Ensure inbox directory exists
    const inboxDir = path.join(this.mailboxDir, recipientDir, "inbox");
    try {
      await fs.mkdir(inboxDir, { recursive: true });
    } catch {
      // May already exist
    }

    const targetPath = path.join(inboxDir, `${id}.json`);
    await this.atomicWrite(targetPath, JSON.stringify(full, null, 2));

    logger.info("mailbox.sent", {
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      id,
    });

    return full;
  }

  // ── Receive ──

  /**
   * Get all unread messages for an agent.
   * Includes both agent-specific inbox and broadcast (_broadcast) messages.
   * Broadcast messages that the agent has already marked as read are excluded.
   */
  async receive(agentType: string): Promise<MailMessage[]> {
    const ownMessages = await this.readMessages(
      path.join(this.mailboxDir, agentType, "inbox")
    );
    const broadcastMessages = await this.readMessages(
      path.join(this.mailboxDir, "_broadcast", "inbox")
    );

    // Filter out broadcast messages that this agent has already read
    const readBroadcastIds = await this.getReadBroadcastIds(agentType);
    const unreadBroadcast = broadcastMessages.filter(
      (m) => !readBroadcastIds.has(m.id)
    );

    // Merge and sort by timestamp ascending
    return [...ownMessages, ...unreadBroadcast].sort(
      (a, b) => a.timestamp - b.timestamp
    );
  }

  // ── Wait ──

  /**
   * Wait for a *new* message to arrive. Polls at `pollIntervalMs`.
   * Pre-fills seenIds with existing messages so only truly new messages are returned.
   * Returns the first new message found, or throws on timeout.
   */
  async waitFor(
    agentType: string,
    opts?: { timeout?: number; interval?: number }
  ): Promise<MailMessage> {
    const timeout = opts?.timeout ?? 30_000;
    const interval = opts?.interval ?? this.pollIntervalMs;
    const deadline = Date.now() + timeout;
    const seenIds = new Set<string>();

    // Pre-populate seen set with all existing messages — do NOT return them.
    // waitFor is specifically for *new* messages; callers should use receive()
    // first if they want to drain existing messages.
    const existing = await this.receive(agentType);
    for (const msg of existing) {
      seenIds.add(msg.id);
    }

    while (Date.now() < deadline) {
      const messages = await this.receive(agentType);
      const newMsg = messages.find((m) => !seenIds.has(m.id));
      if (newMsg) return newMsg;

      await sleep(interval);
    }

    throw new Error(`Mailbox waitFor timed out after ${timeout}ms`);
  }

  // ── Reply ──

  /**
   * Reply to a message. Sets replyTo and preserves correlationId.
   */
  async reply(
    originalId: string,
    from: string,
    body: string
  ): Promise<MailMessage> {
    // Find original message
    const original = await this.findById(originalId);
    if (!original) {
      throw new Error(`Message ${originalId} not found`);
    }

    return this.send({
      from,
      to: original.from,
      subject: `Re: ${original.subject}`,
      body,
      priority: original.priority,
      replyTo: originalId,
      correlationId: original.correlationId ?? originalId,
    });
  }

  // ── Mark Read ──

  /**
   * Move a message from inbox to .read/ subdirectory.
   * For agent-specific messages, moves the file directly.
   * For broadcast messages (_broadcast), uses per-agent read tracking
   * so that marking as read by one agent doesn't affect others.
   */
  async markRead(agentType: string, messageId: string): Promise<void> {
    // Try agent-specific inbox first
    const ownInboxDir = path.join(this.mailboxDir, agentType, "inbox");
    const ownSrcPath = path.join(ownInboxDir, `${messageId}.json`);
    try {
      await fs.access(ownSrcPath);
      // Found in agent inbox — move to .read
      const readDir = path.join(ownInboxDir, ".read");
      const destPath = path.join(readDir, `${messageId}.json`);
      await fs.mkdir(readDir, { recursive: true });
      await fs.rename(ownSrcPath, destPath);
      return;
    } catch {
      // Not in agent inbox
    }

    // Check if it's a broadcast message
    const bcInboxDir = path.join(this.mailboxDir, "_broadcast", "inbox");
    const bcSrcPath = path.join(bcInboxDir, `${messageId}.json`);
    try {
      await fs.access(bcSrcPath);
      // Broadcast message — don't move the shared file; create per-agent read marker instead
      const readMarkerDir = path.join(this.mailboxDir, agentType, ".bc_read");
      await fs.mkdir(readMarkerDir, { recursive: true });
      const markerPath = path.join(readMarkerDir, `${messageId}.json`);
      await this.atomicWrite(markerPath, JSON.stringify({ id: messageId, readAt: Date.now() }));
      return;
    } catch {
      // Not a broadcast message either
    }

    // Message not found in any inbox — log warning but don't throw
    const logger = getLogger();
    logger.warn("mailbox.mark_read_not_found", { agentType, messageId });
  }

  // ── Cleanup ──

  /** Remove messages older than maxAgeMs. Returns count of removed messages. */
  async cleanup(maxAgeMs?: number): Promise<number> {
    const age = maxAgeMs ?? this.maxAgeMs;
    const cutoff = Date.now() - age;
    let removed = 0;

    try {
      const agentDirs = await fs.readdir(this.mailboxDir);
      for (const dir of agentDirs) {
        const agentPath = path.join(this.mailboxDir, dir);
        const stat = await fs.stat(agentPath);
        if (!stat.isDirectory()) continue;

        // Clean inbox
        const inboxDir = path.join(agentPath, "inbox");
        removed += await this.cleanDirectory(inboxDir, cutoff);

        // Clean .read subdirectory
        const readDir = path.join(inboxDir, ".read");
        removed += await this.cleanDirectory(readDir, cutoff);
      }

      // Clean dead letter
      const deadLetterDir = path.join(this.mailboxDir, "_dead_letter");
      removed += await this.cleanDirectory(deadLetterDir, cutoff);
    } catch {
      // mailboxDir may not exist yet
    }

    return removed;
  }

  // ── Stats ──

  /** Get mailbox statistics for an agent (including broadcast messages) */
  async stats(agentType: string): Promise<MailboxStats> {
    const ownInbox = path.join(this.mailboxDir, agentType, "inbox");
    const ownReadDir = path.join(ownInbox, ".read");
    const bcInbox = path.join(this.mailboxDir, "_broadcast", "inbox");

    const ownUnread = (await this.readMessages(ownInbox)).length;
    const ownRead = (await this.readMessages(ownReadDir)).length;

    // For broadcast: count unread = total - read-by-this-agent
    const allBroadcast = (await this.readMessages(bcInbox)).length;
    const readBroadcastIds = await this.getReadBroadcastIds(agentType);
    const bcRead = readBroadcastIds.size;
    const bcUnread = allBroadcast - bcRead;

    return {
      unread: ownUnread + bcUnread,
      read: ownRead + bcRead,
      total: ownUnread + ownRead + allBroadcast,
    };
  }

  // ── Initialize ──

  /** Create mailbox directory structure. Call on startup. */
  async init(): Promise<void> {
    await fs.mkdir(this.mailboxDir, { recursive: true });
    await fs.mkdir(path.join(this.mailboxDir, "_dead_letter"), {
      recursive: true,
    });
  }

  // ── Private helpers ──

  /** Atomic write: temp file → rename */
  private async atomicWrite(targetPath: string, content: string): Promise<void> {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = path.join(dir, `.tmp_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`);
    try {
      await fs.writeFile(tempPath, content, "utf-8");
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      // Clean up temp file on failure
      try { await fs.unlink(tempPath); } catch { /* ignore */ }
      throw err;
    }
  }

  /** Read all message JSON files from a directory */
  private async readMessages(dir: string): Promise<MailMessage[]> {
    const messages: MailMessage[] = [];
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (entry.startsWith(".") || !entry.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(path.join(dir, entry), "utf-8");
          messages.push(JSON.parse(raw) as MailMessage);
        } catch {
          // Skip malformed messages
        }
      }
    } catch {
      // Directory doesn't exist — return empty
    }
    // Sort by timestamp ascending
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Get set of broadcast message IDs that an agent has already read */
  private async getReadBroadcastIds(agentType: string): Promise<Set<string>> {
    const ids = new Set<string>();
    const readDir = path.join(this.mailboxDir, agentType, ".bc_read");
    try {
      const entries = await fs.readdir(readDir);
      for (const entry of entries) {
        if (entry.endsWith(".json")) {
          // Extract message ID from filename: msg_xxx.json → msg_xxx
          ids.add(entry.replace(/\.json$/, ""));
        }
      }
    } catch {
      // Directory doesn't exist — no read markers
    }
    return ids;
  }

  /** Find a message by ID across all directories */
  private async findById(id: string): Promise<MailMessage | null> {
    try {
      const agentDirs = await fs.readdir(this.mailboxDir);
      for (const dir of agentDirs) {
        const agentPath = path.join(this.mailboxDir, dir);
        const stat = await fs.stat(agentPath);
        if (!stat.isDirectory()) continue;

        // Check inbox
        const inboxDir = path.join(agentPath, "inbox");
        const found = await this.findInDir(inboxDir, id);
        if (found) return found;

        // Check .read
        const readDir = path.join(inboxDir, ".read");
        const foundRead = await this.findInDir(readDir, id);
        if (foundRead) return foundRead;
      }

      // Check dead letter
      const deadLetterDir = path.join(this.mailboxDir, "_dead_letter");
      return this.findInDir(deadLetterDir, id);
    } catch {
      return null;
    }
  }

  /** Search for a message by ID in a specific directory */
  private async findInDir(dir: string, id: string): Promise<MailMessage | null> {
    const filePath = path.join(dir, `${id}.json`);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as MailMessage;
    } catch {
      return null;
    }
  }

  /** Remove files older than cutoff timestamp from a directory */
  private async cleanDirectory(dir: string, cutoff: number): Promise<number> {
    let removed = 0;
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        if (!entry.endsWith(".json")) continue;

        const filePath = path.join(dir, entry);
        try {
          const raw = await fs.readFile(filePath, "utf-8");
          const msg = JSON.parse(raw) as MailMessage;
          if (msg.timestamp < cutoff) {
            await fs.unlink(filePath);
            removed++;
          }
        } catch {
          // Malformed file — skip
        }
      }
    } catch {
      // Directory doesn't exist
    }
    return removed;
  }
}

// ── Utility ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
