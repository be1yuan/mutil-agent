import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkflowEngine, type WorkflowEngineDeps } from "./engine.js";
import { WorkflowStateStore } from "./state-store.js";
import type { WorkflowDefinition } from "./types.js";
import type { AgentLoopDeps } from "../agent/agent-loop.js";
import type { AgentResult } from "../types/core.js";

// Mock AgentLoop
vi.mock("../agent/agent-loop.js", () => {
  return {
    AgentLoop: class {
      constructor(public deps: unknown) {}
      async run(task: string, _def: unknown, _budget: number): Promise<AgentResult> {
        return {
          status: "success",
          content: `Executed: ${task}`,
          steps: 1,
          cost: 0.1,
        };
      }
    },
  };
});

// Mock Committee
vi.mock("../agent/committee.js", () => {
  return {
    Committee: class {
      constructor(public deps: unknown) {}
      async run(task: string, _config: unknown, _budget: number) {
        return {
          status: "success",
          content: `Committee: ${task}`,
          members: [],
          strategy: "concat",
          totalCost: 0.2,
          totalSteps: 2,
        };
      }
    },
  };
});

function createMockDeps(): AgentLoopDeps {
  return {
    adapterSelector: { select: () => "deepseek" } as any,
    permissionResolver: { canUse: () => ({ decision: "allow", needsApproval: false }) } as any,
    costTracker: {
      spent: 0,
      remaining: 35,
      canAfford: () => true,
      estimateWorstCase: () => 0.01,
      record: () => {},
    } as any,
    concurrencyLimiter: { acquire: async () => () => {} } as any,
    adapters: new Map(),
    fallbackExecutor: { execute: async () => ({ content: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }) } as any,
    loadAgentDefinition: (type: string) => ({
      agentType: type,
      model: "test-model",
      systemPrompt: "test",
      tools: {},
      maxSteps: 10,
      timeout: 60000,
    }) as any,
    workspaceDir: "/tmp",
  };
}

function createEngine(overrides?: Partial<WorkflowEngineDeps>): WorkflowEngine {
  return new WorkflowEngine({
    agentLoopDeps: createMockDeps(),
    stateStore,
    ...overrides,
  });
}

let tmpDir: string;
let stateStore: WorkflowStateStore;

describe("WorkflowEngine", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-engine-test-"));
    stateStore = new WorkflowStateStore(tmpDir);
    await stateStore.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("executes a sequential workflow", async () => {
    const definition: WorkflowDefinition = {
      name: "test",
      steps: [
        { id: "s1", type: "agent", agentType: "explore", task: "Step 1" },
        { id: "s2", type: "agent", agentType: "coder", task: "Step 2" },
        { id: "s3", type: "agent", agentType: "reviewer", task: "Step 3" },
      ],
    };

    const engine = createEngine();
    const run = await engine.run(definition, 10);

    expect(run.status).toBe("completed");
    expect(run.steps).toHaveLength(3);
    expect(run.steps[0].status).toBe("completed");
    expect(run.steps[1].status).toBe("completed");
    expect(run.steps[2].status).toBe("completed");
    expect(run.totalCost).toBeGreaterThan(0);
  });

  it("executes a committee step", async () => {
    const definition: WorkflowDefinition = {
      name: "committee-test",
      steps: [
        {
          id: "c1",
          type: "committee",
          agentTypes: ["explore", "coder"],
          task: "Committee task",
        },
      ],
    };

    const engine = createEngine();
    const run = await engine.run(definition, 10);

    expect(run.status).toBe("completed");
    expect(run.steps[0].status).toBe("completed");
    expect(run.steps[0].result?.content).toContain("Committee");
  });

  it("evaluates condition and routes to then branch", async () => {
    const definition: WorkflowDefinition = {
      name: "branch-then",
      steps: [
        { id: "s1", type: "agent", agentType: "explore", task: "Step 1" },
        {
          id: "s2",
          type: "agent",
          agentType: "coder",
          task: "Step 2",
          on: {
            condition: { field: "status", operator: "eq", value: "completed" },
            then: "s3",
            else: "s4",
          },
        },
        { id: "s3", type: "agent", agentType: "reviewer", task: "Then branch" },
        { id: "s4", type: "agent", agentType: "reviewer", task: "Else branch" },
      ],
    };

    const engine = createEngine();
    const run = await engine.run(definition, 10);

    expect(run.status).toBe("completed");
    expect(run.steps.find((s) => s.stepId === "s3")?.status).toBe("completed");
    expect(run.steps.find((s) => s.stepId === "s4")?.status).toBe("skipped");
  });

  it("routes to else when condition is not met", async () => {
    const definition: WorkflowDefinition = {
      name: "branch-else",
      steps: [
        { id: "s1", type: "agent", agentType: "explore", task: "Step 1" },
        {
          id: "s2",
          type: "agent",
          agentType: "coder",
          task: "Step 2",
          on: {
            condition: { field: "status", operator: "eq", value: "failed" },
            then: "s3_then",
            else: "s3_else",
          },
        },
        { id: "s3_then", type: "agent", agentType: "reviewer", task: "Then" },
        { id: "s3_else", type: "agent", agentType: "reviewer", task: "Else" },
      ],
    };

    const engine = createEngine();
    const run = await engine.run(definition, 10);

    expect(run.status).toBe("completed");
    expect(run.steps.find((s) => s.stepId === "s3_else")?.status).toBe("completed");
    expect(run.steps.find((s) => s.stepId === "s3_then")?.status).toBe("skipped");
  });

  it("auto-approves checkpoint when autoApprove is true", async () => {
    const definition: WorkflowDefinition = {
      name: "checkpoint-auto",
      steps: [
        { id: "s1", type: "agent", agentType: "explore", task: "Step 1" },
        {
          id: "cp",
          type: "checkpoint",
          task: "Checkpoint",
          checkpoint: { message: "Continue?", autoApprove: true },
        },
        { id: "s2", type: "agent", agentType: "coder", task: "Step 2" },
      ],
    };

    const engine = createEngine();
    const run = await engine.run(definition, 10);

    expect(run.status).toBe("completed");
    expect(run.steps.find((s) => s.stepId === "cp")?.status).toBe("completed");
    expect(run.steps.find((s) => s.stepId === "cp")?.approved).toBe(true);
  });

  it("pauses at checkpoint when onCheckpoint returns false", async () => {
    const definition: WorkflowDefinition = {
      name: "checkpoint-pause",
      steps: [
        { id: "s1", type: "agent", agentType: "explore", task: "Step 1" },
        {
          id: "cp",
          type: "checkpoint",
          task: "Checkpoint",
          checkpoint: { message: "Continue?", autoApprove: false },
        },
        { id: "s2", type: "agent", agentType: "coder", task: "Step 2" },
      ],
    };

    const engine = createEngine({
      onCheckpoint: async () => false,
    });

    const run = await engine.run(definition, 10);

    expect(run.status).toBe("paused");
    expect(run.steps.find((s) => s.stepId === "cp")?.status).toBe("waiting_approval");
  });

  it("resumes from a paused checkpoint", async () => {
    const definition: WorkflowDefinition = {
      name: "resume-test",
      steps: [
        { id: "s1", type: "agent", agentType: "explore", task: "Step 1" },
        {
          id: "cp",
          type: "checkpoint",
          task: "Checkpoint",
          checkpoint: { message: "Continue?", autoApprove: false },
        },
        { id: "s2", type: "agent", agentType: "coder", task: "Step 2" },
      ],
    };

    let checkpointCalls = 0;
    const engine = createEngine({
      onCheckpoint: async () => {
        checkpointCalls++;
        return checkpointCalls > 1;
      },
    });

    const run1 = await engine.run(definition, 10);
    expect(run1.status).toBe("paused");

    const run2 = await engine.resumeWithDefinition(run1.id, definition, 10);
    expect(run2.status).toBe("completed");
    expect(run2.steps.find((s) => s.stepId === "s2")?.status).toBe("completed");
  });

  it("resolves variable interpolation in tasks", async () => {
    const tasks: string[] = [];
    const { AgentLoop } = await import("../agent/agent-loop.js");
    const originalRun = AgentLoop.prototype.run;
    AgentLoop.prototype.run = async function (task: string, def: unknown, budget: number) {
      tasks.push(task);
      return { status: "success" as const, content: `Executed: ${task}`, steps: 1, cost: 0.1 };
    };

    try {
      const definition: WorkflowDefinition = {
        name: "vars-test",
        variables: { dir: "src" },
        steps: [
          { id: "s1", type: "agent", agentType: "explore", task: "Analyze ${dir}" },
          { id: "s2", type: "agent", agentType: "coder", task: "Fix ${steps.s1.content}" },
        ],
      };

      const engine = createEngine();
      await engine.run(definition, 10);

      expect(tasks[0]).toBe("Analyze src");
      expect(tasks[1]).toContain("Executed:");
    } finally {
      AgentLoop.prototype.run = originalRun;
    }
  });

  it("calls onStepComplete callback", async () => {
    const completedSteps: string[] = [];
    const definition: WorkflowDefinition = {
      name: "callback-test",
      steps: [
        { id: "s1", type: "agent", agentType: "explore", task: "Step 1" },
      ],
    };

    const engine = createEngine({
      onStepComplete: (stepId: string) => {
        completedSteps.push(stepId);
      },
    });

    await engine.run(definition, 10);
    expect(completedSteps).toEqual(["s1"]);
  });

  it("calls onWorkflowStatusChange callback", async () => {
    const statuses: string[] = [];
    const definition: WorkflowDefinition = {
      name: "status-callback",
      steps: [
        { id: "s1", type: "agent", agentType: "explore", task: "Step 1" },
      ],
    };

    const engine = createEngine({
      onWorkflowStatusChange: (status: string) => {
        statuses.push(status);
      },
    });

    await engine.run(definition, 10);
    expect(statuses).toContain("running");
    expect(statuses).toContain("completed");
  });

  it("stops on step failure with no branch", async () => {
    const { AgentLoop } = await import("../agent/agent-loop.js");
    const originalRun = AgentLoop.prototype.run;
    AgentLoop.prototype.run = async () => ({
      status: "error" as const,
      error: "test failure",
      steps: 1,
      cost: 0.1,
    });

    try {
      const definition: WorkflowDefinition = {
        name: "fail-test",
        steps: [
          { id: "s1", type: "agent", agentType: "explore", task: "Fail" },
          { id: "s2", type: "agent", agentType: "coder", task: "Should not run" },
        ],
      };

      const engine = createEngine();
      const run = await engine.run(definition, 10);

      expect(run.status).toBe("failed");
      expect(run.steps[0].status).toBe("failed");
      expect(run.steps[1].status).toBe("pending");
    } finally {
      AgentLoop.prototype.run = originalRun;
    }
  });

  it("persists state across steps", async () => {
    const definition: WorkflowDefinition = {
      name: "persist-test",
      steps: [
        { id: "s1", type: "agent", agentType: "explore", task: "Step 1" },
        { id: "s2", type: "agent", agentType: "coder", task: "Step 2" },
      ],
    };

    const engine = createEngine();
    const run = await engine.run(definition, 10);

    const store2 = new WorkflowStateStore(tmpDir);
    const loaded = await store2.load(run.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("completed");
    expect(loaded!.steps).toHaveLength(2);
  });
});
