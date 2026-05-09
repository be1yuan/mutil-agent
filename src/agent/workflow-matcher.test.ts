import { describe, it, expect, vi } from "vitest";
import { matchWorkflow, matchMultipleWorkflows, type MatcherDeps } from "./workflow-matcher.js";
import type { WorkflowDefinition } from "../workflow/types.js";

function makeWorkflow(name: string, description: string, steps = 2): WorkflowDefinition {
  return {
    name,
    description,
    steps: Array.from({ length: steps }, (_, i) => ({
      id: `step${i + 1}`,
      type: "agent" as const,
      agentType: "explore",
      task: `Task ${i + 1}`,
    })),
  };
}

function makeDeps(reply: string): MatcherDeps {
  return {
    fallbackExecutor: {
      execute: vi.fn().mockResolvedValue({ content: reply, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" }),
    } as unknown as MatcherDeps["fallbackExecutor"],
    model: "deepseek-v4-flash",
    provider: "deepseek",
  };
}

describe("WorkflowMatcher", () => {
  describe("matchWorkflow", () => {
    it("returns no match when workflow list is empty", async () => {
      const deps = makeDeps("none");
      const result = await matchWorkflow("test task", [], deps);
      expect(result.matched).toBe(false);
    });

    it("returns matched workflow when LLM returns a name", async () => {
      const workflows = [
        makeWorkflow("code-review", "Code review workflow", 3),
        makeWorkflow("deploy", "Deployment workflow"),
      ];
      const deps = makeDeps("code-review");
      const result = await matchWorkflow("帮我做代码审查", workflows, deps);
      expect(result.matched).toBe(true);
      expect(result.workflowName).toBe("code-review");
      expect(result.workflowDescription).toBe("Code review workflow");
      expect(result.stepCount).toBe(3);
    });

    it("returns no match when LLM returns none", async () => {
      const workflows = [makeWorkflow("deploy", "Deploy workflow")];
      const deps = makeDeps("none");
      const result = await matchWorkflow("写一个排序算法", workflows, deps);
      expect(result.matched).toBe(false);
    });

    it("matches case-insensitively", async () => {
      const workflows = [makeWorkflow("Code-Review", "Review workflow")];
      const deps = makeDeps("code-review");
      const result = await matchWorkflow("review code", workflows, deps);
      expect(result.matched).toBe(true);
      expect(result.workflowName).toBe("Code-Review");
    });

    it("returns no match on LLM error", async () => {
      const workflows = [makeWorkflow("test", "Test workflow")];
      const deps: MatcherDeps = {
        fallbackExecutor: {
          execute: vi.fn().mockRejectedValue(new Error("API error")),
        } as unknown as MatcherDeps["fallbackExecutor"],
        model: "deepseek-v4-flash",
        provider: "deepseek",
      };
      const result = await matchWorkflow("some task", workflows, deps);
      expect(result.matched).toBe(false);
    });

    it("uses cache on repeated calls", async () => {
      const workflows = [makeWorkflow("review", "Review workflow")];
      const deps = makeDeps("review");
      const cache = new Map<string, string>();

      const r1 = await matchWorkflow("do review", workflows, deps, cache);
      expect(r1.matched).toBe(true);

      // Second call should use cache — LLM called only once
      const r2 = await matchWorkflow("do review", workflows, deps, cache);
      expect(r2.matched).toBe(true);
      expect(deps.fallbackExecutor.execute).toHaveBeenCalledTimes(1);
    });

    it("caches negative results", async () => {
      const workflows = [makeWorkflow("deploy", "Deploy workflow")];
      const deps = makeDeps("none");
      const cache = new Map<string, string>();

      await matchWorkflow("unrelated task", workflows, deps, cache);
      // Second call uses cache
      const r2 = await matchWorkflow("unrelated task", workflows, deps, cache);
      expect(r2.matched).toBe(false);
      expect(deps.fallbackExecutor.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("matchMultipleWorkflows", () => {
    it("returns empty when no workflows", async () => {
      const deps = makeDeps("none");
      const result = await matchMultipleWorkflows("task", [], deps);
      expect(result).toEqual([]);
    });

    it("returns multiple matches", async () => {
      const workflows = [
        makeWorkflow("review", "Code review"),
        makeWorkflow("lint", "Linting"),
        makeWorkflow("deploy", "Deploy"),
      ];
      const deps = makeDeps("review, lint");
      const result = await matchMultipleWorkflows("check code quality", workflows, deps);
      expect(result).toHaveLength(2);
      expect(result[0].workflowName).toBe("review");
      expect(result[1].workflowName).toBe("lint");
    });

    it("respects limit parameter", async () => {
      const workflows = [
        makeWorkflow("a", "A"),
        makeWorkflow("b", "B"),
        makeWorkflow("c", "C"),
      ];
      const deps = makeDeps("a, b, c");
      const result = await matchMultipleWorkflows("task", workflows, deps, 2);
      expect(result).toHaveLength(2);
    });

    it("returns empty on LLM error", async () => {
      const deps: MatcherDeps = {
        fallbackExecutor: {
          execute: vi.fn().mockRejectedValue(new Error("fail")),
        } as unknown as MatcherDeps["fallbackExecutor"],
        model: "deepseek-v4-flash",
        provider: "deepseek",
      };
      const result = await matchMultipleWorkflows("task", [makeWorkflow("x", "X")], deps);
      expect(result).toEqual([]);
    });
  });
});
