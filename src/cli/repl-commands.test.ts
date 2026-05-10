import { describe, it, expect, vi } from "vitest";
import { handleCommand, findWorkflowByName, fuzzyMatchCommand, type CommandContext } from "./repl-commands.js";
import type { WorkflowDefinition } from "../workflow/types.js";
import type { AgentDefinition } from "../agent/types.js";

function makeWorkflow(name: string, desc = "test"): WorkflowDefinition {
  return {
    name,
    description: desc,
    steps: [{ id: "s1", type: "agent", agentType: "explore", task: "test" }],
  };
}

function makeAgent(type: string): AgentDefinition {
  return {
    agentType: type,
    model: "test-model",
    description: `Agent ${type}`,
    maxSteps: 10,
    timeout: 60000,
    systemPrompt: "test",
    tools: {},
  };
}

function makeCtx(overrides?: Partial<CommandContext>): CommandContext {
  return {
    workflows: [makeWorkflow("code-review"), makeWorkflow("deploy")],
    agents: new Map([["explore", makeAgent("explore")], ["coder", makeAgent("coder")]]),
    onRunWorkflow: vi.fn(),
    onListWorkflows: vi.fn(),
    onWorkflowStatus: vi.fn(),
    onNewWorkflow: vi.fn(),
    onListAgents: vi.fn(),
    ...overrides,
  };
}

describe("handleCommand", () => {
  it("returns not handled for non-slash input", async () => {
    const result = await handleCommand("帮我做 code review", makeCtx());
    expect(result.handled).toBe(false);
  });

  it("handles /workflow list", async () => {
    const ctx = makeCtx();
    const result = await handleCommand("/workflow list", ctx);
    expect(result.handled).toBe(true);
    expect(result.continue).toBe(true);
    expect(ctx.onListWorkflows).toHaveBeenCalled();
  });

  it("handles /wf as alias for /workflow", async () => {
    const ctx = makeCtx();
    const result = await handleCommand("/wf list", ctx);
    expect(result.handled).toBe(true);
    expect(ctx.onListWorkflows).toHaveBeenCalled();
  });

  it("handles /workflow new", async () => {
    const ctx = makeCtx();
    const result = await handleCommand("/workflow new", ctx);
    expect(result.handled).toBe(true);
    expect(result.continue).toBe(true);
    expect(ctx.onNewWorkflow).toHaveBeenCalled();
  });

  it("handles /workflow run with arg", async () => {
    const ctx = makeCtx();
    const result = await handleCommand("/workflow run code-review", ctx);
    expect(result.handled).toBe(true);
    expect(result.continue).toBe(false);
    expect(ctx.onRunWorkflow).toHaveBeenCalledWith("code-review");
  });

  it("shows usage when /workflow run has no arg", async () => {
    const ctx = makeCtx();
    const result = await handleCommand("/workflow run", ctx);
    expect(result.handled).toBe(true);
    expect(result.continue).toBe(true);
    expect(ctx.onRunWorkflow).not.toHaveBeenCalled();
  });

  it("handles /workflow status with arg", async () => {
    const ctx = makeCtx();
    const result = await handleCommand("/workflow status run-123", ctx);
    expect(result.handled).toBe(true);
    expect(ctx.onWorkflowStatus).toHaveBeenCalledWith("run-123");
  });

  it("handles /agent list", async () => {
    const ctx = makeCtx();
    const result = await handleCommand("/agent list", ctx);
    expect(result.handled).toBe(true);
    expect(result.continue).toBe(true);
    expect(ctx.onListAgents).toHaveBeenCalled();
  });

  it("shows help for unknown /workflow subcommand", async () => {
    const ctx = makeCtx();
    const result = await handleCommand("/workflow foobar", ctx);
    expect(result.handled).toBe(true);
    expect(result.continue).toBe(true);
  });

  it("returns not handled for unknown slash command", async () => {
    const result = await handleCommand("/unknown", makeCtx());
    expect(result.handled).toBe(false);
  });
});

describe("findWorkflowByName", () => {
  const workflows = [makeWorkflow("code-review"), makeWorkflow("deploy-check")];

  it("finds by exact match", () => {
    expect(findWorkflowByName("code-review", workflows)?.name).toBe("code-review");
  });

  it("finds by case-insensitive match", () => {
    expect(findWorkflowByName("Code-Review", workflows)?.name).toBe("code-review");
  });

  it("finds by prefix match", () => {
    expect(findWorkflowByName("code", workflows)?.name).toBe("code-review");
  });

  it("returns undefined for no match", () => {
    expect(findWorkflowByName("nonexistent", workflows)).toBeUndefined();
  });
});

describe("fuzzyMatchCommand", () => {
  it("returns undefined for exact match (no hint needed)", () => {
    expect(fuzzyMatchCommand("/model")).toBeUndefined();
    expect(fuzzyMatchCommand("/workflow")).toBeUndefined();
  });

  it("returns undefined for non-slash input", () => {
    expect(fuzzyMatchCommand("model")).toBeUndefined();
  });

  it("matches prefix when unambiguous", () => {
    expect(fuzzyMatchCommand("/mod")).toBe("/model");
    expect(fuzzyMatchCommand("/langu")).toBe("/language");
    expect(fuzzyMatchCommand("/sav")).toBe("/save");
    expect(fuzzyMatchCommand("/wo")).toBe("/workflow");
  });

  it("returns undefined when prefix is ambiguous", () => {
    // "/lan" is ambiguous (/language + /lang)
    expect(fuzzyMatchCommand("/lan")).toBeUndefined();
  });

  it("matches by edit distance for typos", () => {
    expect(fuzzyMatchCommand("/modle")).toBe("/model");     // 1 swap
    expect(fuzzyMatchCommand("/worfklow")).toBe("/workflow"); // 1 transposition
  });

  it("returns undefined for completely unrelated input", () => {
    expect(fuzzyMatchCommand("/xyzabc")).toBeUndefined();
  });

  it("strips arguments before matching", () => {
    expect(fuzzyMatchCommand("/mod some args")).toBe("/model");
    expect(fuzzyMatchCommand("/sav file.txt")).toBe("/save");
  });
});
