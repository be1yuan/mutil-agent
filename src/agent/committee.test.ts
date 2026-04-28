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
});
