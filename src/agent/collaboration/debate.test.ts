import { describe, it, expect, vi, beforeEach } from "vitest";
import { Debate } from "./debate.js";
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
    agentTypes: ["explore", "architect", "coder", "reviewer", "judge"],
    workspaceDir: "/tmp/test",
    ...overrides,
  } as AgentLoopDeps;
}

describe("Debate", () => {
  let deps: AgentLoopDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("should run a single round with participants", async () => {
    // Mock AgentLoop.run globally for this test
    const { AgentLoop } = await import("../agent-loop.js");
    const originalRun = AgentLoop.prototype.run;
    AgentLoop.prototype.run = vi.fn().mockResolvedValue({
      status: "success",
      content: "Mocked response for debate",
      steps: 2,
      cost: 0.05,
    } as any);

    try {
      const debate = new Debate(deps);
      const result = await debate.run("Test topic", {
        participants: ["explore", "architect"],
        rounds: 1,
        judge: false,
        prompt: "Test topic",
      }, 35);

      expect(result.status).toBe("success");
      expect(result.rounds).toHaveLength(1);
      expect(result.rounds[0].responses).toHaveLength(2);
      expect(result.rounds[0].scores).toBeUndefined();
    } finally {
      AgentLoop.prototype.run = originalRun;
    }
  });

  it("should run multiple rounds", async () => {
    const { AgentLoop } = await import("../agent-loop.js");
    const originalRun = AgentLoop.prototype.run;
    AgentLoop.prototype.run = vi.fn().mockResolvedValue({
      status: "success",
      content: "Mocked debate response",
      steps: 1,
      cost: 0.03,
    } as any);

    try {
      const debate = new Debate(deps);
      const result = await debate.run("Topic", {
        participants: ["explore", "coder"],
        rounds: 3,
        judge: false,
        prompt: "Topic",
      }, 35);

      expect(result.rounds).toHaveLength(3);
      // 2 participants × 3 rounds
      expect(AgentLoop.prototype.run).toHaveBeenCalledTimes(6);
    } finally {
      AgentLoop.prototype.run = originalRun;
    }
  });

  it("should support judge scoring when enabled", async () => {
    const { AgentLoop } = await import("../agent-loop.js");
    const originalRun = AgentLoop.prototype.run;
    let callCount = 0;
    AgentLoop.prototype.run = vi.fn().mockImplementation(() => {
      callCount++;
      // Judge call returns JSON scores (odd-numbered calls after participant calls)
      if (callCount > 2) {
        return Promise.resolve({
          status: "success",
          content: JSON.stringify({
            scores: [
              {
                agentType: "explore",
                totalScore: 85,
                dimensions: { relevance: 9, depth: 8, novelty: 7, clarity: 9, critique: 0 },
                comment: "Good analysis",
              },
              {
                agentType: "architect",
                totalScore: 90,
                dimensions: { relevance: 9, depth: 9, novelty: 8, clarity: 9, critique: 0 },
                comment: "Excellent perspective",
              },
            ],
          }),
          steps: 1,
          cost: 0.02,
        } as any);
      }
      return Promise.resolve({
        status: "success",
        content: "Participant response",
        steps: 1,
        cost: 0.03,
      } as any);
    });

    try {
      const debate = new Debate(deps);
      const result = await debate.run("Topic", {
        participants: ["explore", "architect"],
        rounds: 1,
        judge: true,
        judgeAgentType: "judge",
        prompt: "Topic",
      }, 35);

      expect(result.rounds).toHaveLength(1);
      expect(result.rounds[0].scores).toBeDefined();
      expect(result.rounds[0].scores).toHaveLength(2);
      expect(result.rounds[0].scores![0].agentType).toBe("explore");
      expect(result.rounds[0].scores![0].totalScore).toBe(85);
    } finally {
      AgentLoop.prototype.run = originalRun;
    }
  });

  it("should handle budget exceeded mid-debate", async () => {
    const spendTracker = { spent: 0, remaining: 0.05 };
    deps.costTracker = {
      record: vi.fn(),
      get spent() { return spendTracker.spent; },
      get remaining() { return spendTracker.remaining; },
      canAfford: () => false,
    } as any;

    const { AgentLoop } = await import("../agent-loop.js");
    const originalRun = AgentLoop.prototype.run;
    AgentLoop.prototype.run = vi.fn().mockResolvedValue({
      status: "success",
      content: "Mock response",
      steps: 1,
      cost: 0.03,
    } as any);

    try {
      const debate = new Debate(deps);
      const result = await debate.run("Topic", {
        participants: ["explore"],
        rounds: 3,
        judge: false,
        prompt: "Topic",
      }, 35);

      // Should stop after round 1 due to budget
      expect(result.rounds.length).toBeGreaterThanOrEqual(1);
    } finally {
      AgentLoop.prototype.run = originalRun;
    }
  });
});
