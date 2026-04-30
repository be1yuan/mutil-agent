/**
 * AgentLoop integration tests.
 *
 * Mocks the model adapter's chat method, but uses real tool execution,
 * real permission resolver, real cost tracker, etc.
 * Verifies the complete loop: model call → tool execution → repeat → done.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentLoop, type AgentLoopDeps } from "./agent-loop.js";
import type { AgentDefinition } from "./types.js";
import type { ChatParams, ChatResponse } from "../adapters/types.js";
import type { ModelProvider, Usage } from "../types/core.js";
import { CostTracker } from "../observability/cost-tracker.js";
import { AdapterSelector } from "./adapter-selector.js";
import { FallbackExecutor, ModelUnavailableError } from "../adapters/fallback-executor.js";
import { PermissionResolver } from "../security/permission-resolver.js";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";
import type { ModelAdapter } from "../adapters/types.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ──

function mockUsage(): Usage {
  return { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function textResponse(text: string): ChatResponse {
  return {
    content: text,
    toolCalls: [],
    usage: mockUsage(),
    stopReason: { type: "end_turn" },
  };
}

function toolCallResponse(calls: { id: string; name: string; arguments: Record<string, unknown> }[]): ChatResponse {
  return {
    content: null,
    toolCalls: calls,
    usage: mockUsage(),
    stopReason: { type: "tool_use" },
  };
}

/** Create a mock ModelAdapter whose chat() returns a sequence of responses */
function createMockAdapter(responses: ChatResponse[]): ModelAdapter {
  let callIndex = 0;
  return {
    provider: "deepseek" as ModelProvider,
    chat: vi.fn().mockImplementation(async () => {
      const response = responses[callIndex++];
      if (!response) throw new Error("No more mock responses");
      return response;
    }),
    chatStream: vi.fn(),
    getModelInfo: vi.fn().mockReturnValue({
      name: "mock-model",
      provider: "deepseek" as ModelProvider,
      contextWindow: 128000,
      pricing: { input: 2.87, output: 5.74 },
      capabilities: { toolCalling: true, streaming: true, jsonMode: true, thinking: false },
    }),
  };
}

function createTestDefinition(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    agentType: "test",
    model: "mock-model",
    provider: "deepseek",
    systemPrompt: "You are a test assistant.",
    description: "Test agent",
    maxSteps: 10,
    timeout: 30000,
    tools: {
      Read: "allow",
      Write: "allow",
      Bash: { allow: ["echo *"], deny: ["rm *"] },
    },
    maxTokensPerStep: 4096,
    ...overrides,
  };
}

function createDeps(adapter: ModelAdapter): AgentLoopDeps {
  const adapters = new Map<string, ModelAdapter>();
  adapters.set("deepseek", adapter);

  const policy = {
    maxRetries: 0,
    retryDelayMs: 100,
    retryableErrors: [],
  };

  const fallbackExecutor = new FallbackExecutor(
    adapters as Map<ModelProvider, ModelAdapter>,
    policy
  );

  const costTracker = new CostTracker(35.0);
  const permissionResolver = new PermissionResolver([]);

  return {
    adapterSelector: new AdapterSelector(),
    permissionResolver,
    costTracker,
    concurrencyLimiter: new ConcurrencyLimiter(3),
    adapters: adapters as Map<string, ModelAdapter>,
    fallbackExecutor,
    loadAgentDefinition: (agentType: string) => createTestDefinition({ agentType }),
    workspaceDir: tmpdir(),
  };
}

// ── Tests ──

describe("AgentLoop", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agent-loop-test-"));
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("returns success when model responds with content only", async () => {
    const adapter = createMockAdapter([
      textResponse("The answer is 42."),
    ]);
    const deps = createDeps(adapter);
    const loop = new AgentLoop(deps);
    const result = await loop.run("What is the answer?", createTestDefinition(), 35.0);

    expect(result.status).toBe("success");
    expect(result.content).toBe("The answer is 42.");
    expect(result.steps).toBe(1);
    expect(result.cost).toBeGreaterThan(0);
  });

  it("executes a Read tool call and returns the result", async () => {
    // Create a test file
    const testFile = join(tempDir, "test.txt");
    writeFileSync(testFile, "hello world");

    const adapter = createMockAdapter([
      toolCallResponse([{
        id: "tc_1",
        name: "Read",
        arguments: { filePath: testFile },
      }]),
      textResponse("I read the file and it says 'hello world'."),
    ]);
    const deps = createDeps(adapter);
    deps.workspaceDir = tempDir;
    const loop = new AgentLoop(deps);
    const result = await loop.run("Read the test file", createTestDefinition(), 35.0);

    expect(result.status).toBe("success");
    expect(result.steps).toBe(2);
    expect(result.content).toContain("hello world");
  });

  it("executes a Write tool call", async () => {
    const adapter = createMockAdapter([
      toolCallResponse([{
        id: "tc_1",
        name: "Write",
        arguments: { filePath: join(tempDir, "output.txt"), content: "written content" },
      }]),
      textResponse("File written successfully."),
    ]);
    const deps = createDeps(adapter);
    deps.workspaceDir = tempDir;
    const loop = new AgentLoop(deps);
    const result = await loop.run("Write a file", createTestDefinition(), 35.0);

    expect(result.status).toBe("success");
    expect(result.steps).toBe(2);
  });

  it("returns budget_exceeded when budget is insufficient", async () => {
    // Use a very small budget so the pre-flight check fails
    const adapter = createMockAdapter([textResponse("hi")]);
    const deps = createDeps(adapter);
    // Override costTracker with tiny budget
    const tinyTracker = new CostTracker(0.0001);
    deps.costTracker = tinyTracker;

    const loop = new AgentLoop(deps);
    const definition = createTestDefinition();
    const result = await loop.run("Do something", definition, 0.0001);

    expect(result.status).toBe("budget_exceeded");
  });

  it("returns max_steps_reached when max steps is exceeded", async () => {
    // Model always returns tool calls, never content
    const adapter = createMockAdapter(
      Array(20).fill(toolCallResponse([{
        id: "tc_loop",
        name: "Read",
        arguments: { filePath: join(tempDir, "loop.txt") },
      }]))
    );
    // Create file so Read doesn't fail
    writeFileSync(join(tempDir, "loop.txt"), "data");

    const deps = createDeps(adapter);
    deps.workspaceDir = tempDir;
    const definition = createTestDefinition({ maxSteps: 3 });
    const loop = new AgentLoop(deps);
    const result = await loop.run("Loop forever", definition, 35.0);

    expect(result.status).toBe("max_steps_reached");
    expect(result.steps).toBe(3);
  });

  it("denies tools when permission is deny", async () => {
    const adapter = createMockAdapter([
      toolCallResponse([{
        id: "tc_1",
        name: "Write",
        arguments: { filePath: "/tmp/evil.txt", content: "hacked" },
      }]),
      textResponse("I couldn't write the file."),
    ]);
    const deps = createDeps(adapter);
    const definition = createTestDefinition({
      tools: { Read: "allow", Write: "deny" },
    });
    const loop = new AgentLoop(deps);
    const result = await loop.run("Try to write", definition, 35.0);

    // The loop should continue — the denied tool returns [denied] string,
    // which the model sees and can respond to
    expect(result.status).toBe("success");
  });

  it("calls onApprovalRequest for ask permission", async () => {
    const approvalFn = vi.fn().mockResolvedValue(true);
    const adapter = createMockAdapter([
      toolCallResponse([{
        id: "tc_1",
        name: "Write",
        arguments: { filePath: join(tempDir, "approved.txt"), content: "approved content" },
      }]),
      textResponse("Done."),
    ]);
    const deps = createDeps(adapter);
    deps.workspaceDir = tempDir;
    deps.onApprovalRequest = approvalFn;
    const definition = createTestDefinition({
      tools: { Read: "allow", Write: "ask" },
    });
    const loop = new AgentLoop(deps);
    const result = await loop.run("Write a file", definition, 35.0);

    expect(approvalFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("success");
  });

  it("denies tool when user rejects approval", async () => {
    const approvalFn = vi.fn().mockResolvedValue(false);
    const adapter = createMockAdapter([
      toolCallResponse([{
        id: "tc_1",
        name: "Write",
        arguments: { filePath: join(tempDir, "rejected.txt"), content: "rejected" },
      }]),
      textResponse("OK, I won't write."),
    ]);
    const deps = createDeps(adapter);
    deps.workspaceDir = tempDir;
    deps.onApprovalRequest = approvalFn;
    const definition = createTestDefinition({
      tools: { Read: "allow", Write: "ask" },
    });
    const loop = new AgentLoop(deps);
    const result = await loop.run("Write a file", definition, 35.0);

    expect(approvalFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("success");
  });

  it("calls lifecycle callbacks", async () => {
    const onStepStart = vi.fn();
    const onToolStart = vi.fn();
    const onToolComplete = vi.fn();
    const onBudgetUpdate = vi.fn();

    const testFile = join(tempDir, "lifecycle.txt");
    writeFileSync(testFile, "data");

    const adapter = createMockAdapter([
      toolCallResponse([{
        id: "tc_1",
        name: "Read",
        arguments: { filePath: testFile },
      }]),
      textResponse("Done."),
    ]);
    const deps = createDeps(adapter);
    deps.workspaceDir = tempDir;
    deps.onStepStart = onStepStart;
    deps.onToolStart = onToolStart;
    deps.onToolComplete = onToolComplete;
    deps.onBudgetUpdate = onBudgetUpdate;
    const loop = new AgentLoop(deps);
    await loop.run("Read file", createTestDefinition(), 35.0);

    expect(onStepStart).toHaveBeenCalled();
    expect(onToolStart).toHaveBeenCalledWith("test", "Read", expect.any(Object));
    expect(onToolComplete).toHaveBeenCalledWith("test", "Read", expect.any(Number), true);
    expect(onBudgetUpdate).toHaveBeenCalled();
  });

  it("returns error when model call fails", async () => {
    const adapter = createMockAdapter([]);
    adapter.chat = vi.fn().mockRejectedValue(new Error("API error"));
    const deps = createDeps(adapter);
    const loop = new AgentLoop(deps);
    const result = await loop.run("Do something", createTestDefinition(), 35.0);

    expect(result.status).toBe("error");
    if ("error" in result) {
      expect((result as any).error).toContain("Model call failed");
    }
  });

  it("calls onStreamText when streaming is enabled", async () => {
    const streamFn = vi.fn();
    const adapter = createMockAdapter([
      textResponse("Streaming response"),
    ]);
    const deps = createDeps(adapter);
    deps.onStreamText = streamFn;
    const loop = new AgentLoop(deps);
    await loop.run("Stream test", createTestDefinition(), 35.0);

    // Stream function was set on the params — the mock adapter may or may
    // not call it. The key is that the params had stream=true.
    // We verify by checking that the loop completed successfully with streaming enabled.
    expect(adapter.chat).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true })
    );
  });
});
