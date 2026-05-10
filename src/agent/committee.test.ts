import { describe, it, expect, vi } from "vitest";
import { Committee } from "./committee.js";
import type { AgentLoopDeps } from "./agent-loop.js";
import type { AgentResult } from "../types/core.js";
import type { ModelProvider } from "../types/core.js";

// ── Mock AgentLoop ──

// We mock the AgentLoop by intercepting its constructor and run method.
// Since Committee creates new AgentLoop instances internally, we use
// a factory pattern with dependency injection.

function createMockDeps(overrides?: Partial<AgentLoopDeps>): AgentLoopDeps {
  return {
    adapterSelector: { select: () => "deepseek" as ModelProvider } as any,
    permissionResolver: { canUse: () => ({ decision: "allow", needsApproval: false }) } as any,
    costTracker: { record: vi.fn(), spent: 0, remaining: 5 } as any,
    concurrencyLimiter: { acquire: () => Promise.resolve(() => {}) } as any,
    adapters: new Map(),
    fallbackExecutor: { execute: vi.fn() } as any,
    loadAgentDefinition: (type: string) => ({
      agentType: type,
      model: "test-model",
      systemPrompt: "test",
      tools: { Read: "allow" },
      maxSteps: 10,
      timeout: 30000,
    }),
    agentTypes: ["explore", "coder", "reviewer"],
    workspaceDir: "/test",
    ...overrides,
  };
}

// ── Committee Tests ──

describe("Committee", () => {
  it("runs multiple agent types and concatenates results", async () => {
    // We can't easily mock AgentLoop's run method since Committee
    // creates new instances. Instead, we'll test the aggregation
    // logic directly and test the full flow with a simpler integration test.

    const committee = new Committee(createMockDeps());

    // Test aggregation directly
    const memberResults = [
      { agentType: "explore", result: { status: "success", content: "Found 3 files", steps: 5, cost: 0.01 } as AgentResult },
      { agentType: "coder", result: { status: "success", content: "Refactored auth", steps: 8, cost: 0.02 } as AgentResult },
    ];

    // Access private method via any for unit testing
    const aggregated = (committee as any).aggregate(memberResults, "concat");

    expect(aggregated.status).toBe("success");
    expect(aggregated.content).toContain("[explore]");
    expect(aggregated.content).toContain("[coder]");
    expect(aggregated.content).toContain("Found 3 files");
    expect(aggregated.content).toContain("Refactored auth");
  });

  it("majority strategy picks the most common status", async () => {
    const committee = new Committee(createMockDeps());

    const memberResults = [
      { agentType: "explore", result: { status: "success", content: "A", steps: 1, cost: 0.01 } as AgentResult },
      { agentType: "coder", result: { status: "error", error: "failed", steps: 2, cost: 0.02 } as AgentResult },
      { agentType: "reviewer", result: { status: "success", content: "B", steps: 3, cost: 0.03 } as AgentResult },
    ];

    const aggregated = (committee as any).aggregate(memberResults, "majority");

    expect(aggregated.status).toBe("success"); // 2 success vs 1 error
  });

  it("best strategy picks the longest content", async () => {
    const committee = new Committee(createMockDeps());

    const memberResults = [
      { agentType: "explore", result: { status: "success", content: "Short", steps: 1, cost: 0.01 } as AgentResult },
      { agentType: "coder", result: { status: "success", content: "This is a much longer and more detailed response", steps: 2, cost: 0.02 } as AgentResult },
    ];

    const aggregated = (committee as any).aggregate(memberResults, "best");

    expect(aggregated.status).toBe("success");
    expect(aggregated.content).toBe("This is a much longer and more detailed response");
  });

  it("returns error for empty results", async () => {
    const committee = new Committee(createMockDeps());

    const aggregated = (committee as any).aggregate([], "concat");

    expect(aggregated.status).toBe("error");
  });

  it("single member result is returned directly", async () => {
    const committee = new Committee(createMockDeps());

    const memberResults = [
      { agentType: "coder", result: { status: "success", content: "Done", steps: 5, cost: 0.01 } as AgentResult },
    ];

    const aggregated = (committee as any).aggregate(memberResults, "concat");

    expect(aggregated.status).toBe("success");
    expect(aggregated.content).toBe("Done");
  });

  it("partial status when some agents fail", async () => {
    const committee = new Committee(createMockDeps());

    const memberResults = [
      { agentType: "explore", result: { status: "success", content: "OK", steps: 1, cost: 0.01 } as AgentResult },
      { agentType: "coder", result: { status: "error", error: "failed", steps: 2, cost: 0.02 } as AgentResult },
    ];

    const aggregated = (committee as any).aggregate(memberResults, "concat");

    expect(aggregated.status).toBe("partial");
  });

  // ── Weighted strategy tests ──

  it("weighted-majority: picks success when enough weighted votes", async () => {
    const committee = new Committee(createMockDeps());

    const memberResults = [
      { agentType: "explore", result: { status: "success", content: "A", steps: 1, cost: 0.01 } as AgentResult },
      { agentType: "coder", result: { status: "error", error: "failed", steps: 2, cost: 0.02 } as AgentResult },
      { agentType: "reviewer", result: { status: "error", error: "failed", steps: 1, cost: 0.01 } as AgentResult },
    ];

    // explore has weight 3, coder has 1, reviewer has 1 → weighted sum 3/5 >= 50%
    const aggregated = (committee as any).aggregate(memberResults, "weighted-majority", {
      explore: 3.0,
      coder: 1.0,
      reviewer: 1.0,
    });

    expect(aggregated.status).toBe("success");
    expect(aggregated.content).toBe("A");
  });

  it("weighted-majority: returns partial when weighted sum below half", async () => {
    const committee = new Committee(createMockDeps());

    const memberResults = [
      { agentType: "explore", result: { status: "success", content: "A", steps: 1, cost: 0.01 } as AgentResult },
      { agentType: "coder", result: { status: "error", error: "failed", steps: 2, cost: 0.02 } as AgentResult },
      { agentType: "reviewer", result: { status: "error", error: "failed", steps: 1, cost: 0.01 } as AgentResult },
    ];

    // explore has weight 1, others 3 each → weighted sum 1/7 < 50%
    const aggregated = (committee as any).aggregate(memberResults, "weighted-majority", {
      explore: 1.0,
      coder: 3.0,
      reviewer: 3.0,
    });

    expect(aggregated.status).toBe("partial");
  });

  it("weighted-majority: defaults to weight 1.0 for unspecified agents", async () => {
    const committee = new Committee(createMockDeps());

    const memberResults = [
      { agentType: "explore", result: { status: "success", content: "A", steps: 1, cost: 0.01 } as AgentResult },
      { agentType: "coder", result: { status: "success", content: "B", steps: 1, cost: 0.01 } as AgentResult },
    ];

    // No weights provided, defaults to 1.0 each → 2/2 >= 50% → success
    const aggregated = (committee as any).aggregate(memberResults, "weighted-majority");

    expect(aggregated.status).toBe("success");
  });

  it("weighted-best: picks highest weight×length product", async () => {
    const committee = new Committee(createMockDeps());

    const memberResults = [
      { agentType: "explore", result: { status: "success", content: "This is a very long and detailed exploration result", steps: 5, cost: 0.05 } as AgentResult },
      { agentType: "reviewer", result: { status: "success", content: "Short", steps: 1, cost: 0.01 } as AgentResult },
    ];

    // reviewer has huge weight → reviewer's "Short" (5*10=50) > explore (52*1=52) → actually explore wins still
    // Let me adjust: reviewer weight 20 → "Short".length*20 = 100 > 52
    const aggregated = (committee as any).aggregate(memberResults, "weighted-best", {
      explore: 1.0,
      reviewer: 20.0,
    });

    expect(aggregated.status).toBe("success");
    expect(aggregated.content).toBe("Short");
  });

  it("weighted-best: defaults to weight 1.0 for unspecified agents", async () => {
    const committee = new Committee(createMockDeps());

    const memberResults = [
      { agentType: "explore", result: { status: "success", content: "Short", steps: 1, cost: 0.01 } as AgentResult },
      { agentType: "coder", result: { status: "success", content: "A much longer response from coder", steps: 3, cost: 0.03 } as AgentResult },
    ];

    // No weights → coder wins by length
    const aggregated = (committee as any).aggregate(memberResults, "weighted-best");

    expect(aggregated.status).toBe("success");
    expect(aggregated.content).toBe("A much longer response from coder");
  });
});
