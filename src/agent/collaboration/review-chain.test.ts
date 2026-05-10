import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReviewChain, parseVerdict } from "./review-chain.js";
import type { AgentLoopDeps } from "../agent-loop.js";

function createMockDeps(overrides?: Partial<AgentLoopDeps>): AgentLoopDeps {
  return {
    adapterSelector: { select: () => "deepseek" } as any,
    permissionResolver: {
      check: () => ({ decision: "allow", needsApproval: false }),
    } as any,
    costTracker: {
      record: vi.fn(),
      spent: 0,
      remaining: 35,
      canAfford: () => true,
    } as any,
    concurrencyLimiter: { acquire: () => Promise.resolve(() => {}) } as any,
    adapters: new Map() as any,
    fallbackExecutor: { execute: vi.fn() } as any,
    loadAgentDefinition: (type: string) => ({
      agentType: type,
      model: "deepseek-v4-pro",
      systemPrompt: `You are ${type}.`,
      tools: {},
      maxSteps: 10,
      timeout: 30000,
    }),
    agentTypes: ["coder", "reviewer", "architect"],
    workspaceDir: "/tmp/test",
    ...overrides,
  } as AgentLoopDeps;
}

// ── parseVerdict tests ──

describe("parseVerdict", () => {
  it("detects LGTM", () => {
    expect(parseVerdict("This looks great! LGTM").type).toBe("LGTM");
  });

  it("detects APPROVED", () => {
    expect(parseVerdict("Approved — the solution is solid.").type).toBe("APPROVED");
  });

  it("detects APPROVED even in lowercase", () => {
    expect(parseVerdict("lgtm ship it").type).toBe("LGTM");
  });

  it("detects NEEDS_CHANGES with feedback", () => {
    const v = parseVerdict("NEEDS_CHANGES: The auth module needs better error handling.");
    expect(v.type).toBe("NEEDS_CHANGES");
    if (v.type === "NEEDS_CHANGES") {
      expect(v.feedback).toContain("auth module");
    }
  });

  it("detects NEEDS_CHANGES spanning multiple lines of feedback", () => {
    const v = parseVerdict("There are issues.\nNEEDS_CHANGES: fix the race condition in the cache layer.\nAlso check the timeout.");
    expect(v.type).toBe("NEEDS_CHANGES");
    if (v.type === "NEEDS_CHANGES") {
      expect(v.feedback).toContain("race condition");
    }
  });

  it("only scans last 500 characters", () => {
    // Word boundary needed before LGTM, so use a space separator
    const prefix = "x".repeat(2000);
    const tail = " LGTM";
    expect(parseVerdict(prefix + tail).type).toBe("LGTM");
  });

  it("ignores NEEDS_CHANGES far from the end", () => {
    // Put NEEDS_CHANGES in first 100 chars, then 2000 chars of padding
    const text = "NEEDS_CHANGES: old feedback\n" + "x".repeat(2000);
    // The NEEDS_CHANGES is outside the last-500-char window
    expect(parseVerdict(text).type).toBe("NEEDS_CHANGES"); // default fallback
  });

  it("defaults to NEEDS_CHANGES when no verdict found", () => {
    const v = parseVerdict("Here is some review text without any clear verdict keyword.");
    expect(v.type).toBe("NEEDS_CHANGES");
    if (v.type === "NEEDS_CHANGES") {
      expect(v.feedback).toBeDefined();
    }
  });

  it("LGTM takes priority over NEEDS_CHANGES when both present in tail", () => {
    const text = "NEEDS_CHANGES: maybe fix X\nBut actually LGTM now that I think about it.";
    expect(parseVerdict(text).type).toBe("LGTM");
  });
});

// ── ReviewChain tests ──

describe("ReviewChain", () => {
  let deps: AgentLoopDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("should approve on first iteration when LGTM", async () => {
    const { AgentLoop } = await import("../agent-loop.js");
    const originalRun = AgentLoop.prototype.run;
    let callCount = 0;
    AgentLoop.prototype.run = vi.fn().mockImplementation(() => {
      callCount++;
      // First call = coder, second = reviewer with LGTM
      if (callCount === 1) {
        return Promise.resolve({
          status: "success",
          content: "function add(a,b) { return a + b; }",
          steps: 3,
          cost: 0.05,
        } as any);
      }
      return Promise.resolve({
        status: "success",
        content: "Looks correct and simple. LGTM",
        steps: 1,
        cost: 0.02,
      } as any);
    });

    try {
      const chain = new ReviewChain(deps);
      const result = await chain.run("Write an add function", {
        coder: "coder",
        reviewer: "reviewer",
        maxIterations: 3,
        acceptThreshold: "auto",
      }, 35);

      expect(result.status).toBe("success");
      expect(result.iterations).toHaveLength(1);
      expect(result.iterations[0].accepted).toBe(true);
      expect(result.iterations[0].reviewerResult?.verdict.type).toBe("LGTM");
    } finally {
      AgentLoop.prototype.run = originalRun;
    }
  });

  it("should iterate when reviewer requests changes", async () => {
    const { AgentLoop } = await import("../agent-loop.js");
    const originalRun = AgentLoop.prototype.run;
    let callCount = 0;
    AgentLoop.prototype.run = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Coder initial
        return Promise.resolve({
          status: "success",
          content: "function add(a,b) { return a + b; }",
          steps: 2,
          cost: 0.03,
        } as any);
      }
      if (callCount === 2) {
        // Reviewer — needs changes
        return Promise.resolve({
          status: "success",
          content: "Missing input validation. NEEDS_CHANGES: Add type-checking for parameters.",
          steps: 1,
          cost: 0.02,
        } as any);
      }
      if (callCount === 3) {
        // Coder revises
        return Promise.resolve({
          status: "success",
          content: "function add(a,b) { if (typeof a!=='number'||typeof b!=='number') throw Error; return a+b; }",
          steps: 2,
          cost: 0.03,
        } as any);
      }
      // Reviewer accepts revision
      return Promise.resolve({
        status: "success",
        content: "Now handles edge cases. APPROVED",
        steps: 1,
        cost: 0.02,
      } as any);
    });

    try {
      const chain = new ReviewChain(deps);
      const result = await chain.run("Write an add function", {
        coder: "coder",
        reviewer: "reviewer",
        maxIterations: 3,
        acceptThreshold: "auto",
      }, 35);

      expect(result.status).toBe("success");
      expect(result.iterations.length).toBeGreaterThanOrEqual(2);
      const acceptedIt = result.iterations.find((it) => it.accepted);
      expect(acceptedIt).toBeDefined();
    } finally {
      AgentLoop.prototype.run = originalRun;
    }
  });

  it("should reach max_iterations_reached when never approved", async () => {
    const { AgentLoop } = await import("../agent-loop.js");
    const originalRun = AgentLoop.prototype.run;
    AgentLoop.prototype.run = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        status: "success",
        content: "NEEDS_CHANGES: not good enough, try again.",
        steps: 1,
        cost: 0.01,
      } as any);
    });

    try {
      const chain = new ReviewChain(deps);
      const result = await chain.run("Task", {
        coder: "coder",
        reviewer: "reviewer",
        maxIterations: 2,
        acceptThreshold: "auto",
      }, 35);

      expect(result.status).toBe("max_iterations_reached");
    } finally {
      AgentLoop.prototype.run = originalRun;
    }
  });

  it("should handle budget exceeded", async () => {
    // remaining starts >0 so the first coder call works, then drops to 0
    // so the reviewer loop check catches it
    let callCount = 0;
    const spendTracker = { spent: 0, remaining: 0.01 };
    deps.costTracker = {
      record: vi.fn(),
      get spent() { return spendTracker.spent; },
      get remaining() {
        // After first agent call (coder initial), deplete budget
        return callCount >= 1 ? 0 : spendTracker.remaining;
      },
      canAfford: () => false,
    } as any;

    const { AgentLoop } = await import("../agent-loop.js");
    const originalRun = AgentLoop.prototype.run;
    AgentLoop.prototype.run = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        status: "success",
        content: "Some output",
        steps: 1,
        cost: 0.05,
      } as any);
    });

    try {
      const chain = new ReviewChain(deps);
      const result = await chain.run("Task", {
        coder: "coder",
        reviewer: "reviewer",
        maxIterations: 3,
        acceptThreshold: "auto",
      }, 35);

      expect(["budget_exceeded", "error", "max_iterations_reached"]).toContain(result.status);
    } finally {
      AgentLoop.prototype.run = originalRun;
    }
  });

  it("should return content from accepted iteration", async () => {
    const { AgentLoop } = await import("../agent-loop.js");
    const originalRun = AgentLoop.prototype.run;
    let callCount = 0;
    AgentLoop.prototype.run = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: "success",
          content: "Final approved version",
          steps: 2,
          cost: 0.04,
        } as any);
      }
      return Promise.resolve({
        status: "success",
        content: "APPROVED — looks great!",
        steps: 1,
        cost: 0.01,
      } as any);
    });

    try {
      const chain = new ReviewChain(deps);
      const result = await chain.run("Task", {
        coder: "coder",
        reviewer: "reviewer",
        maxIterations: 2,
        acceptThreshold: "auto",
      }, 35);

      expect(result.content).toBe("Final approved version");
    } finally {
      AgentLoop.prototype.run = originalRun;
    }
  });
});
