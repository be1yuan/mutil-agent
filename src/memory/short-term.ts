/**
 * ShortTermMemory — session-level memory management.
 *
 * Stores conversation entries and summaries per session.
 * Each entry is an individual JSON file under sessions/{id}/entries/ to avoid
 * read-modify-write races between concurrent agents writing to the same session.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { atomicWrite, atomicRead, validatePathSegment } from "./persistence.js";
import type { MemoryEntry, ConversationSummary } from "./types.js";

export class ShortTermMemory {
  constructor(
    private memoryDir: string,
    private maxEntries: number,
    private threshold: number
  ) {}

  getSessionDir(sessionId: string): string {
    return path.join(this.memoryDir, "sessions", sessionId);
  }

  private getEntriesDir(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), "entries");
  }

  /** Store a memory entry for a session. Each entry is its own file to avoid races. */
  async storeEntry(sessionId: string, entry: MemoryEntry): Promise<void> {
    validatePathSegment(sessionId);
    validatePathSegment(entry.id);
    const dir = this.getEntriesDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const entryPath = path.join(dir, `${entry.id}.json`);
    await atomicWrite(entryPath, JSON.stringify(entry, null, 2));

    // Trim if over max (evict oldest by timestamp)
    await this.trimEntries(sessionId);
  }

  /** Get all entries for a session (sorted newest first). */
  async getEntries(sessionId: string): Promise<MemoryEntry[]> {
    validatePathSegment(sessionId);
    const dir = this.getEntriesDir(sessionId);
    const entries: MemoryEntry[] = [];
    try {
      const dirents = await fs.readdir(dir);
      for (const dirent of dirents) {
        if (!dirent.endsWith(".json")) continue;
        const entry = await atomicRead<MemoryEntry>(path.join(dir, dirent));
        if (entry) entries.push(entry);
      }
    } catch {
      return [];
    }
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries;
  }

  /** Store conversation summary. */
  async storeSummary(sessionId: string, summary: ConversationSummary): Promise<void> {
    validatePathSegment(sessionId);
    const dir = this.getSessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const summaryPath = path.join(dir, "summary.json");
    await atomicWrite(summaryPath, JSON.stringify(summary, null, 2));
  }

  /** Get conversation summary. */
  async getSummary(sessionId: string): Promise<ConversationSummary | null> {
    validatePathSegment(sessionId);
    const summaryPath = path.join(this.getSessionDir(sessionId), "summary.json");
    return atomicRead<ConversationSummary>(summaryPath);
  }

  /** Estimate token count from conversation history (chars/4 heuristic). */
  shouldSummarize(history: unknown[]): boolean {
    let chars = 0;
    for (const msg of history as Array<Record<string, unknown>>) {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.text && typeof block.text === "string") chars += block.text.length;
          if (block.content && typeof block.content === "string") chars += block.content.length;
        }
      }
    }
    return Math.ceil(chars / 4) > this.threshold;
  }

  /** List all session IDs. */
  async listSessions(): Promise<string[]> {
    const sessionsDir = path.join(this.memoryDir, "sessions");
    try {
      const entries = await fs.readdir(sessionsDir);
      return entries.filter((e) => !e.startsWith("."));
    } catch {
      return [];
    }
  }

  /** Remove oldest entries if count exceeds maxEntries. */
  private async trimEntries(sessionId: string): Promise<void> {
    const entries = await this.getEntries(sessionId);
    if (entries.length <= this.maxEntries) return;
    // Entries are sorted newest-first, so oldest are at the end
    const toDelete = entries.slice(this.maxEntries);
    const dir = this.getEntriesDir(sessionId);
    for (const entry of toDelete) {
      try { await fs.unlink(path.join(dir, `${entry.id}.json`)); } catch { /* ok */ }
    }
  }
}
