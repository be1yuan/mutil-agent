import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Mailbox, type MailMessage } from "./mailbox.js";

describe("Mailbox", () => {
  let tmpDir: string;
  let mailbox: Mailbox;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mailbox-test-"));
    mailbox = new Mailbox(tmpDir, { pollIntervalMs: 50 });
    await mailbox.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Send & Receive ──

  it("should send and receive a message", async () => {
    const msg = await mailbox.send({
      from: "coder",
      to: "reviewer",
      subject: "Code ready",
      body: "Please review src/foo.ts",
      priority: "normal",
    });

    expect(msg.id).toMatch(/^msg_\d+_[0-9a-f]{8}$/);
    expect(msg.from).toBe("coder");
    expect(msg.to).toBe("reviewer");
    expect(msg.timestamp).toBeGreaterThan(0);

    const received = await mailbox.receive("reviewer");
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(msg.id);
    expect(received[0].subject).toBe("Code ready");
  });

  it("should return empty array for agent with no messages", async () => {
    const received = await mailbox.receive("nonexistent");
    expect(received).toHaveLength(0);
  });

  it("should sort messages by timestamp ascending", async () => {
    await mailbox.send({
      from: "a",
      to: "main",
      subject: "First",
      body: "1",
      priority: "low",
    });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await mailbox.send({
      from: "b",
      to: "main",
      subject: "Second",
      body: "2",
      priority: "high",
    });

    const received = await mailbox.receive("main");
    expect(received).toHaveLength(2);
    expect(received[0].subject).toBe("First");
    expect(received[1].subject).toBe("Second");
  });

  // ── Broadcast ──

  it("should support broadcast messages (to=*)", async () => {
    await mailbox.send({
      from: "main",
      to: "*",
      subject: "Broadcast",
      body: "Hello everyone",
      priority: "normal",
    });

    // Broadcast messages are stored in "_broadcast" directory
    // Any agent should be able to receive them via receive()
    const received = await mailbox.receive("reviewer");
    expect(received).toHaveLength(1);
    expect(received[0].subject).toBe("Broadcast");
    expect(received[0].to).toBe("*");
  });

  it("should include broadcast messages in receive for any agent", async () => {
    await mailbox.send({
      from: "main",
      to: "*",
      subject: "Announcement",
      body: "Deploying at 5pm",
      priority: "high",
    });

    // Both coder and reviewer should see the broadcast
    const coderMessages = await mailbox.receive("coder");
    const reviewerMessages = await mailbox.receive("reviewer");
    expect(coderMessages).toHaveLength(1);
    expect(reviewerMessages).toHaveLength(1);
    expect(coderMessages[0].id).toBe(reviewerMessages[0].id);
  });

  // ── Mark Read ──

  it("should mark messages as read", async () => {
    const msg = await mailbox.send({
      from: "coder",
      to: "main",
      subject: "Done",
      body: "Task completed",
      priority: "normal",
    });

    // Should be unread
    let messages = await mailbox.receive("main");
    expect(messages).toHaveLength(1);

    // Mark as read
    await mailbox.markRead("main", msg.id);

    // Should be gone from inbox
    messages = await mailbox.receive("main");
    expect(messages).toHaveLength(0);

    // Stats should reflect read
    const stats = await mailbox.stats("main");
    expect(stats.unread).toBe(0);
    expect(stats.read).toBe(1);
  });

  // ── Reply ──

  it("should reply to a message", async () => {
    const original = await mailbox.send({
      from: "reviewer",
      to: "coder",
      subject: "Review request",
      body: "Please fix the bug",
      priority: "high",
    });

    const reply = await mailbox.reply(original.id, "coder", "Bug fixed in commit abc123");
    expect(reply.to).toBe("reviewer");
    expect(reply.replyTo).toBe(original.id);
    expect(reply.correlationId).toBe(original.id);
    expect(reply.subject).toBe("Re: Review request");

    // Reviewer should have the reply
    const received = await mailbox.receive("reviewer");
    expect(received).toHaveLength(1);
    expect(received[0].body).toBe("Bug fixed in commit abc123");
  });

  it("should preserve correlationId in reply chain", async () => {
    const msg1 = await mailbox.send({
      from: "a",
      to: "b",
      subject: "Start",
      body: "1",
      priority: "normal",
      correlationId: "corr-123",
    });

    const msg2 = await mailbox.reply(msg1.id, "b", "Reply 1");
    expect(msg2.correlationId).toBe("corr-123");

    const msg3 = await mailbox.reply(msg2.id, "a", "Reply 2");
    expect(msg3.correlationId).toBe("corr-123");
  });

  // ── Wait ──

  it("should wait for a new message", async () => {
    // Send a message after a short delay
    setTimeout(async () => {
      await mailbox.send({
        from: "coder",
        to: "main",
        subject: "Delayed",
        body: "Arrived",
        priority: "normal",
      });
    }, 200);

    const msg = await mailbox.waitFor("main", { timeout: 5000, interval: 50 });
    expect(msg.subject).toBe("Delayed");
  });

  it("should timeout when no message arrives", async () => {
    await expect(
      mailbox.waitFor("main", { timeout: 200, interval: 50 })
    ).rejects.toThrow("timed out");
  });

  it("should skip existing messages and only return new ones", async () => {
    // Pre-existing message — waitFor should NOT return this
    await mailbox.send({
      from: "coder",
      to: "main",
      subject: "Old message",
      body: "Already here",
      priority: "normal",
    });

    // Send a new message after a delay
    setTimeout(async () => {
      await mailbox.send({
        from: "coder",
        to: "main",
        subject: "New message",
        body: "Just arrived",
        priority: "normal",
      });
    }, 200);

    const msg = await mailbox.waitFor("main", { timeout: 5000, interval: 50 });
    expect(msg.subject).toBe("New message");
  });

  it("should wait for broadcast messages", async () => {
    setTimeout(async () => {
      await mailbox.send({
        from: "main",
        to: "*",
        subject: "Broadcast Alert",
        body: "Deploying",
        priority: "high",
      });
    }, 200);

    const msg = await mailbox.waitFor("coder", { timeout: 5000, interval: 50 });
    expect(msg.subject).toBe("Broadcast Alert");
    expect(msg.to).toBe("*");
  });

  // ── Stats ──

  it("should report correct stats including broadcast messages", async () => {
    await mailbox.send({
      from: "a",
      to: "main",
      subject: "Direct",
      body: "1",
      priority: "normal",
    });
    await mailbox.send({
      from: "main",
      to: "*",
      subject: "Broadcast",
      body: "2",
      priority: "normal",
    });

    // main should see 2 messages: 1 direct + 1 broadcast
    let stats = await mailbox.stats("main");
    expect(stats.unread).toBe(2);
    expect(stats.read).toBe(0);
    expect(stats.total).toBe(2);

    // Mark the direct message as read
    const messages = await mailbox.receive("main");
    const directMsg = messages.find((m) => m.to === "main");
    await mailbox.markRead("main", directMsg!.id);

    stats = await mailbox.stats("main");
    expect(stats.unread).toBe(1);
    expect(stats.read).toBe(1);
    expect(stats.total).toBe(2);
  });

  it("should mark broadcast messages as read", async () => {
    const msg = await mailbox.send({
      from: "main",
      to: "*",
      subject: "Broadcast",
      body: "Hello",
      priority: "normal",
    });

    // Mark as read for coder
    await mailbox.markRead("coder", msg.id);

    // Coder's receive should no longer include it
    const coderMsgs = await mailbox.receive("coder");
    expect(coderMsgs).toHaveLength(0);

    // But reviewer should still see it (markRead only affects the sender's view)
    const reviewerMsgs = await mailbox.receive("reviewer");
    expect(reviewerMsgs).toHaveLength(1);
  });

  // ── Cleanup ──

  it("should clean up old messages", async () => {
    const msg = await mailbox.send({
      from: "a",
      to: "main",
      subject: "Old",
      body: "stale",
      priority: "low",
    });

    // Manually age the message by overwriting its timestamp
    const inboxDir = path.join(tmpDir, "main", "inbox");
    const filePath = path.join(inboxDir, `${msg.id}.json`);
    const content: MailMessage = {
      ...msg,
      timestamp: Date.now() - 100_000, // 100s ago
    };
    await fs.writeFile(filePath, JSON.stringify(content), "utf-8");

    // Cleanup messages older than 50s
    const removed = await mailbox.cleanup(50_000);
    expect(removed).toBe(1);

    const messages = await mailbox.receive("main");
    expect(messages).toHaveLength(0);
  });

  // ── Atomic write ──

  it("should use atomic writes (no temp files left behind)", async () => {
    await mailbox.send({
      from: "a",
      to: "b",
      subject: "Atomic",
      body: "test",
      priority: "normal",
    });

    const inboxDir = path.join(tmpDir, "b", "inbox");
    const entries = await fs.readdir(inboxDir);
    const tempFiles = entries.filter((e) => e.startsWith(".tmp_"));
    expect(tempFiles).toHaveLength(0);
  });

  // ── Priority ──

  it("should preserve message priority", async () => {
    await mailbox.send({
      from: "a",
      to: "b",
      subject: "Urgent",
      body: "ASAP",
      priority: "high",
    });

    const received = await mailbox.receive("b");
    expect(received[0].priority).toBe("high");
  });
});
