/**
 * API server integration tests.
 *
 * Uses Node.js built-in http module to send real HTTP requests
 * to a real ApiServer instance. AgentLoopDeps are mocked so no
 * actual model calls are made.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { ApiServer, type ServerOpts } from "./server.js";
import type { AgentLoopDeps } from "../agent/agent-loop.js";
import type { AgentDefinition } from "../agent/types.js";
import type { OrchestratorConfig } from "../config/types.js";
import type { CostTracker } from "../observability/cost-tracker.js";
import type { PermissionResolver } from "../security/permission-resolver.js";
import type { ConcurrencyLimiter } from "../agent/concurrency-limiter.js";
import type { FallbackExecutor } from "../adapters/fallback-executor.js";
import type { Mailbox } from "../agent/mailbox.js";

// ── Helpers ──

function makeRequest(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: {
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Mocks ──

function createMockConfig(): OrchestratorConfig {
  return {
    providers: {
      deepseek: {
        apiKey: "test-key",
        baseURL: "https://api.deepseek.com/anthropic",
        defaultModel: "deepseek-v4-pro",
      },
      zhipu: {
        apiKey: "test-key",
        baseURL: "https://open.bigmodel.cn/api/anthropic",
        defaultModel: "glm-5.1",
      },
      mimo: {
        apiKey: "test-key",
        baseURL: "https://api.mimo.com/anthropic",
        defaultModel: "mimo-v2-pro",
      },
      kimi: {
        apiKey: "test-key",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        defaultModel: "kimi-k2.6",
      },
      qwen: {
        apiKey: "test-key",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        defaultModel: "qwen3.6-max-preview",
      },
    },
    fallback: {
      maxRetries: 3,
      retryDelayMs: 1000,
      retryableErrors: ["rate_limit"],
    },
    security: {
      maxConcurrentAgents: 3,
      requireApproval: [],
    },
    budget: { maxYuan: 35.0 },
    observability: {
      logLevel: "info",
      metricsEnabled: true,
    },
  };
}

function createMockDeps(): AgentLoopDeps {
  const mockCostTracker = {
    budgetAmount: 35.0,
    spent: 0,
    remaining: 35.0,
    record: vi.fn(),
    canAfford: vi.fn().mockReturnValue(true),
    estimateWorstCase: vi.fn().mockReturnValue(0.01),
  } as unknown as CostTracker;

  return {
    adapterSelector: { select: vi.fn().mockReturnValue("deepseek") } as any,
    permissionResolver: { canUse: vi.fn().mockReturnValue({ decision: "allow", needsApproval: false }) } as unknown as PermissionResolver,
    costTracker: mockCostTracker,
    concurrencyLimiter: { acquire: vi.fn().mockResolvedValue(vi.fn()) } as unknown as ConcurrencyLimiter,
    adapters: new Map(),
    fallbackExecutor: { execute: vi.fn() } as unknown as FallbackExecutor,
    loadAgentDefinition: vi.fn(),
    workspaceDir: "/tmp/test",
  };
}

function createMockAgentDefinitions(): Map<string, AgentDefinition> {
  const defs = new Map<string, AgentDefinition>();
  defs.set("main", {
    agentType: "main",
    model: "deepseek-v4-pro",
    provider: "deepseek",
    systemPrompt: "You are a helpful assistant.",
    description: "General-purpose agent",
    maxSteps: 20,
    maxTokensPerStep: 4096,
    timeout: 30000,
    tools: { Read: "allow" },
  });
  defs.set("explore", {
    agentType: "explore",
    model: "deepseek-v4-flash",
    provider: "deepseek",
    systemPrompt: "Explore the codebase.",
    description: "Code explorer",
    maxSteps: 15,
    maxTokensPerStep: 4096,
    timeout: 30000,
    tools: { Read: "allow", Grep: "allow" },
  });
  return defs;
}

// ── Tests ──

describe("ApiServer", () => {
  let server: ApiServer;
  let port: number;
  const config = createMockConfig();
  const deps = createMockDeps();
  const agentDefs = createMockAgentDefinitions();

  beforeAll(async () => {
    // Use port 0 to let the OS assign a free port
    const opts: ServerOpts = {
      host: "127.0.0.1",
      port: 0,
      authToken: "test-token-123",
      cors: true,
    };
    server = new ApiServer(config, opts, agentDefs, deps);
    await server.start();
    // Get the actual port assigned by the OS
    const address = (server as any).server?.address();
    port = address?.port ?? 13000;
  });

  afterAll(async () => {
    await server.stop();
  });

  // ── Health check ──

  it("GET /api/health returns ok", async () => {
    const res = await makeRequest(port, {
      method: "GET",
      path: "/api/health",
      headers: { Authorization: "Bearer test-token-123" },
    });
    expect(res.status).toBe(200);
    expect((res.body as any).status).toBe("ok");
    expect((res.body as any).agents).toBe(2);
    expect(typeof (res.body as any).uptime).toBe("number");
  });

  // ── Authentication ──

  it("returns 401 without auth token", async () => {
    const res = await makeRequest(port, {
      method: "GET",
      path: "/api/health",
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong auth token", async () => {
    const res = await makeRequest(port, {
      method: "GET",
      path: "/api/health",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct auth token", async () => {
    const res = await makeRequest(port, {
      method: "GET",
      path: "/api/health",
      headers: { Authorization: "Bearer test-token-123" },
    });
    expect(res.status).toBe(200);
  });

  // ── List agents ──

  it("GET /api/agents returns agent list", async () => {
    const res = await makeRequest(port, {
      method: "GET",
      path: "/api/agents",
      headers: { Authorization: "Bearer test-token-123" },
    });
    expect(res.status).toBe(200);
    const agents = (res.body as any).agents;
    expect(agents).toHaveLength(2);
    expect(agents[0].type).toBe("main");
    expect(agents[1].type).toBe("explore");
  });

  // ── Cost info ──

  it("GET /api/cost returns cost tracker info", async () => {
    const res = await makeRequest(port, {
      method: "GET",
      path: "/api/cost",
      headers: { Authorization: "Bearer test-token-123" },
    });
    expect(res.status).toBe(200);
    expect(typeof (res.body as any).spent).toBe("number");
    expect(typeof (res.body as any).remaining).toBe("number");
  });

  // ── Submit task ──

  it("POST /api/tasks creates a task", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/tasks",
      headers: { Authorization: "Bearer test-token-123" },
      body: { task: "Analyze the codebase", agentType: "explore", budget: 10.0 },
    });
    expect(res.status).toBe(201);
    expect(typeof (res.body as any).id).toBe("string");
    // Status may be "queued" or "running" since processQueue starts immediately
    expect(["queued", "running"]).toContain((res.body as any).status);
    expect((res.body as any).agentType).toBe("explore");
    expect((res.body as any).budget).toBe(10.0);
  });

  it("POST /api/tasks without task field returns 400", async () => {
    const res = await makeRequest(port, {
      method: "POST",
      path: "/api/tasks",
      headers: { Authorization: "Bearer test-token-123" },
      body: { agentType: "main" },
    });
    expect(res.status).toBe(400);
  });

  // ── Get task ──

  it("GET /api/tasks/:id returns task details", async () => {
    // First create a task
    const createRes = await makeRequest(port, {
      method: "POST",
      path: "/api/tasks",
      headers: { Authorization: "Bearer test-token-123" },
      body: { task: "Test task" },
    });
    const taskId = (createRes.body as any).id;

    // Then get it
    const res = await makeRequest(port, {
      method: "GET",
      path: `/api/tasks/${taskId}`,
      headers: { Authorization: "Bearer test-token-123" },
    });
    expect(res.status).toBe(200);
    expect((res.body as any).id).toBe(taskId);
    expect((res.body as any).task).toBe("Test task");
  });

  it("GET /api/tasks/:id with non-existent ID returns 404", async () => {
    const res = await makeRequest(port, {
      method: "GET",
      path: "/api/tasks/non-existent-uuid",
      headers: { Authorization: "Bearer test-token-123" },
    });
    expect(res.status).toBe(404);
  });

  // ── 404 ──

  it("returns 404 for unknown routes", async () => {
    const res = await makeRequest(port, {
      method: "GET",
      path: "/api/unknown",
      headers: { Authorization: "Bearer test-token-123" },
    });
    expect(res.status).toBe(404);
  });

  // ── CORS ──

  it("OPTIONS request returns CORS headers", async () => {
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            method: "OPTIONS",
            path: "/api/health",
          },
          (res) => {
            resolve({ status: res.statusCode ?? 0, headers: res.headers });
          }
        );
        req.on("error", reject);
        req.end();
      }
    );
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });

  // ── Request body size limit ──

  it("rejects request body over 1MB", async () => {
    // Create a large body (just over 1MB) — the server will destroy the
    // connection, so we expect either a 413 response or a socket error.
    const largeBody = { task: "x".repeat(1_000_001) };
    try {
      const res = await makeRequest(port, {
        method: "POST",
        path: "/api/tasks",
        headers: { Authorization: "Bearer test-token-123" },
        body: largeBody,
      });
      // If we get a response, it should be 413
      expect(res.status).toBe(413);
    } catch (err) {
      // Socket hang up is also acceptable (server destroyed the connection)
      expect((err as Error).message).toContain("hang up");
    }
  });
});
