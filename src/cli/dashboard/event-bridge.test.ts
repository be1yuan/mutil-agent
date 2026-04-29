/**
 * Tests for DashboardEventBridge — verifies that lifecycle callbacks
 * are properly bridged to EventEmitter events, including the approval
 * flow, budget throttling, and callback chaining.
 */

import { describe, it, expect, vi } from "vitest";
import { DashboardEventBridge } from "./event-bridge.js";
import type { DashboardEvent } from "./types.js";

describe("DashboardEventBridge", () => {
  it("should emit step event when onStepStart is called", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    const deps = bridge.createDeps({} as any);
    deps.onStepStart?.(3, "coder");

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0] as DashboardEvent;
    expect(event.type).toBe("step");
    expect(event.data).toEqual({ step: 3, agentType: "coder" });
  });

  it("should emit tool_start event when onToolStart is called", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    const deps = bridge.createDeps({} as any);
    deps.onToolStart?.("coder", "Bash", { command: "npm test" });

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0] as DashboardEvent;
    expect(event.type).toBe("tool_start");
    expect(event.data).toEqual({
      agentType: "coder",
      toolName: "Bash",
      args: { command: "npm test" },
    });
  });

  it("should emit tool_complete event when onToolComplete is called", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    const deps = bridge.createDeps({} as any);
    deps.onToolComplete?.("coder", "Bash", 1234, true);

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0] as DashboardEvent;
    expect(event.type).toBe("tool_complete");
    expect(event.data).toEqual({
      agentType: "coder",
      toolName: "Bash",
      duration: 1234,
      success: true,
    });
  });

  it("should emit subagent_spawn event when onSubAgentSpawn is called", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    const deps = bridge.createDeps({} as any);
    deps.onSubAgentSpawn?.("main", "explore", "search for auth");

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0] as DashboardEvent;
    expect(event.type).toBe("subagent_spawn");
    expect(event.data).toEqual({
      parent: "main",
      child: "explore",
      task: "search for auth",
    });
  });

  it("should emit subagent_complete event when onSubAgentComplete is called", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    const deps = bridge.createDeps({} as any);
    deps.onSubAgentComplete?.("main", "explore", {
      status: "success",
      steps: 5,
      cost: 0.01,
    });

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0] as DashboardEvent;
    expect(event.type).toBe("subagent_complete");
    expect(event.data).toEqual({
      parent: "main",
      child: "explore",
      result: { status: "success", steps: 5, cost: 0.01 },
    });
  });

  it("should emit budget event when onBudgetUpdate is called", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    const deps = bridge.createDeps({} as any);
    deps.onBudgetUpdate?.(1.5, 3.5);

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0] as DashboardEvent;
    expect(event.type).toBe("budget");
    expect(event.data).toEqual({ spent: 1.5, remaining: 3.5 });
  });

  it("should emit stream event when onStreamText is called", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    const deps = bridge.createDeps({} as any);
    deps.onStreamText?.("Hello world");

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0] as DashboardEvent;
    expect(event.type).toBe("stream");
    expect(event.data).toEqual({ text: "Hello world" });
  });

  it("should call original baseDeps callbacks before emitting", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    const originalCallback = vi.fn();
    const deps = bridge.createDeps({
      onStepStart: originalCallback,
    } as any);

    deps.onStepStart?.(1, "main");

    // Original callback called first
    expect(originalCallback).toHaveBeenCalledWith(1, "main");
    // Then bridge emitted event
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should emit done event (with preceding budget flush) via emitDone", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    bridge.emitDone("success", 10, 0.05, "task completed");

    // emitDone first flushes a budget event, then emits done
    expect(handler).toHaveBeenCalledTimes(2);
    const budgetEvent = handler.mock.calls[0][0] as DashboardEvent;
    expect(budgetEvent.type).toBe("budget");
    expect(budgetEvent.data).toEqual({ spent: 0.05, remaining: 0 });

    const doneEvent = handler.mock.calls[1][0] as DashboardEvent;
    expect(doneEvent.type).toBe("done");
    expect(doneEvent.data).toEqual({
      status: "success",
      steps: 10,
      cost: 0.05,
      content: "task completed",
    });
  });

  it("should emit approval event via emitApprovalRequest with id", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    bridge.emitApprovalRequest("coder", "Bash", { command: "rm -rf /" });

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0] as DashboardEvent;
    expect(event.type).toBe("approval");
    expect(event.data).toMatchObject({
      id: 1,
      agentType: "coder",
      toolName: "Bash",
      args: { command: "rm -rf /" },
    });
  });

  it("should include timestamp in all events", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    const before = Date.now();
    const deps = bridge.createDeps({} as any);
    deps.onStepStart?.(1, "main");
    const after = Date.now();

    const event = handler.mock.calls[0][0] as DashboardEvent;
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
  });

  it("should handle multiple events in sequence", () => {
    const bridge = new DashboardEventBridge();
    const events: DashboardEvent[] = [];
    bridge.on("event", (e) => events.push(e));

    const deps = bridge.createDeps({} as any);
    deps.onStepStart?.(1, "main");
    deps.onToolStart?.("main", "Read", { file_path: "a.ts" });
    deps.onToolComplete?.("main", "Read", 10, true);
    deps.onBudgetUpdate?.(0.01, 4.99);

    expect(events).toHaveLength(4);
    expect(events.map((e) => e.type)).toEqual([
      "step",
      "tool_start",
      "tool_complete",
      "budget",
    ]);
  });

  // ── New tests for approval flow ──

  it("should return a Promise from onApprovalRequest that resolves via resolveApproval", async () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    const deps = bridge.createDeps({} as any);
    const promise = deps.onApprovalRequest?.({
      agentType: "coder",
      toolName: "Bash",
      arguments: { command: "rm -rf /" },
    });

    // Approval event should have been emitted
    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0] as DashboardEvent;
    expect(event.type).toBe("approval");

    // Resolve the approval
    bridge.resolveApproval(true);
    const result = await promise;
    expect(result).toBe(true);
  });

  it("should deny approval via resolveApproval(false)", async () => {
    const bridge = new DashboardEventBridge();
    const deps = bridge.createDeps({} as any);

    const promise = deps.onApprovalRequest?.({
      agentType: "coder",
      toolName: "Bash",
      arguments: { command: "rm -rf /" },
    });

    bridge.resolveApproval(false);
    const result = await promise;
    expect(result).toBe(false);
  });

  it("should return null for getPendingApprovalId when no approval is pending", () => {
    const bridge = new DashboardEventBridge();
    expect(bridge.getPendingApprovalId()).toBeNull();
  });

  // ── New test for budget throttling ──

  it("should throttle budget events within the throttle window", () => {
    const bridge = new DashboardEventBridge();
    const handler = vi.fn();
    bridge.on("event", handler);

    const deps = bridge.createDeps({} as any);

    // First call goes through
    deps.onBudgetUpdate?.(1.0, 4.0);
    expect(handler).toHaveBeenCalledTimes(1);

    // Rapid subsequent calls within 200ms are throttled
    deps.onBudgetUpdate?.(1.1, 3.9);
    deps.onBudgetUpdate?.(1.2, 3.8);
    deps.onBudgetUpdate?.(1.3, 3.7);
    // Still only 1 call — the rapid ones were throttled
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
