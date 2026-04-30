/**
 * Cross-instance mailbox tests.
 *
 * Two independent Mailbox instances pointing to the same directory
 * simulates cross-process communication. Since the mailbox is file-based
 * with atomic writes, separate instances are functionally equivalent
 * to separate processes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Mailbox, type MailMessage } from "./mailbox.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Mailbox cross-instance communication", () => {
  let tempDir: string;
  let mailboxDir: string;
  let sender: Mailbox;
  let receiver: Mailbox;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mailbox-ci-test-"));
    mailboxDir = join(tempDir, ".mailbox");
    sender = new Mailbox(mailboxDir, { pollIntervalMs: 100 });
    receiver = new Mailbox(mailboxDir, { pollIntervalMs: 100 });
  });

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("sender can send a message that receiver reads", async () => {
    const msg = await sender.send({
      from: "agent-a",
      to: "agent-b",
      subject: "Test message",
      body: "Hello from A",
      priority: "normal",
    });
    expect(msg.id).toBeTruthy();

    const messages = await receiver.receive("agent-b");
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const found = messages.find((m) => m.id === msg.id);
    expect(found).toBeDefined();
    expect(found!.from).toBe("agent-a");
    expect(found!.to).toBe("agent-b");
    expect(found!.body).toBe("Hello from A");
  });

  it("sender can broadcast and receiver gets it", async () => {
    const msg = await sender.send({
      from: "agent-a",
      to: "*",
      subject: "Broadcast",
      body: "To all agents",
      priority: "normal",
    });
    expect(msg.id).toBeTruthy();

    const messages = await receiver.receive("agent-c");
    const found = messages.find((m) => m.id === msg.id);
    expect(found).toBeDefined();
    expect(found!.to).toBe("*");
  });

  it("receiver can reply to sender's message", async () => {
    // Sender sends
    const original = await sender.send({
      from: "agent-a",
      to: "agent-d",
      subject: "Question",
      body: "What time?",
      priority: "normal",
    });

    // Receiver reads and replies
    const received = await receiver.receive("agent-d");
    const origMsg = received.find((m) => m.id === original.id);
    expect(origMsg).toBeDefined();

    const reply = await receiver.send({
      from: "agent-d",
      to: "agent-a",
      subject: "Re: Question",
      body: "3 PM",
      priority: "normal",
      replyTo: original.id,
    });

    // Sender gets reply
    const replies = await sender.receive("agent-a");
    const replyMsg = replies.find((m) => m.id === reply.id);
    expect(replyMsg).toBeDefined();
    expect(replyMsg!.replyTo).toBe(original.id);
    expect(replyMsg!.from).toBe("agent-d");
  });

  it("receiver can waitFor a message from sender", async () => {
    // Clean first — remove all messages (maxAge=0 removes everything)
    await receiver.cleanup(0);

    // Start waiting
    const waitPromise = receiver.waitFor("agent-e", { timeout: 5000 });

    // Sender sends after a delay
    setTimeout(async () => {
      await sender.send({
        from: "agent-a",
        to: "agent-e",
        subject: "Delayed",
        body: "Better late than never",
        priority: "normal",
      });
    }, 300);

    const msg = await waitPromise;
    expect(msg).toBeDefined();
    expect(msg.subject).toBe("Delayed");
  });

  it("stats are consistent across instances", async () => {
    // Clean first
    await receiver.cleanup(0);

    // Sender sends
    await sender.send({
      from: "agent-a",
      to: "agent-f",
      subject: "Stat test",
      body: "body",
      priority: "normal",
    });

    // Check stats from receiver
    const stats = await receiver.stats("agent-f");
    expect(stats.unread).toBeGreaterThanOrEqual(1);
  });

  it("multiple messages maintain integrity", async () => {
    // Clean first
    await receiver.cleanup(0);

    // Send 5 messages in sequence
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const msg = await sender.send({
        from: "agent-a",
        to: "agent-g",
        subject: `Msg ${i}`,
        body: `Body ${i}`,
        priority: "normal",
      });
      ids.push(msg.id);
    }

    // Receiver gets all
    const messages = await receiver.receive("agent-g");
    const received = messages.filter((m) => ids.includes(m.id));
    expect(received.length).toBe(5);

    // Verify all are present
    for (const id of ids) {
      expect(received.some((m) => m.id === id)).toBe(true);
    }
  });
});
