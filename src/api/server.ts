/**
 * Zero-dependency HTTP API server.
 *
 * Uses Node.js built-in `node:http` module. No Express / Fastify.
 *
 * Endpoints:
 *   POST   /api/tasks           — Submit a new task
 *   GET    /api/tasks/:id       — Get task status/result
 *   GET    /api/tasks/:id/stream — SSE real-time stream
 *   GET    /api/agents          — List available agents
 *   GET    /api/health          — Health check
 *   GET    /api/cost            — Cost tracker info
 */

import crypto from "node:crypto";
import http from "node:http";
import type { ServerResponse, IncomingMessage } from "node:http";
import type { OrchestratorConfig } from "../config/types.js";
import type { AgentDefinition } from "../agent/types.js";
import type { CostTracker } from "../observability/cost-tracker.js";
import type { Mailbox } from "../agent/mailbox.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import { TaskManager, type SubmitTaskRequest, type TaskStatus } from "./task-manager.js";
import { AgentLoopDeps } from "../agent/agent-loop.js";
import { initSSE, GlobalSSEClientSet } from "./sse.js";
import { getLogger } from "../observability/logger.js";
import { WorkflowEngine, WorkflowStateStore, loadWorkflow } from "../workflow/index.js";
import type { WorkflowDefinition } from "../workflow/index.js";

// ── Types ──

export interface ServerOpts {
  host: string;
  port: number;
  authToken?: string;
  cors: boolean;
}

// ── Server ──

/** Simple IP-based rate limiter */
class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests = 60, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /** Returns true if the request should be allowed */
  allow(ip: string): boolean {
    const now = Date.now();
    let entry = this.hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(ip, entry);
    }
    entry.count++;
    return entry.count <= this.maxRequests;
  }

  /** Periodically clean up stale entries */
  cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.hits) {
      if (now > entry.resetAt) {
        this.hits.delete(ip);
      }
    }
  }
}

export class ApiServer {
  private server?: http.Server;
  private taskManager?: TaskManager;
  private rateLimiter = new RateLimiter(60, 60_000); // 60 req/min per IP
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private workflowStateStore?: WorkflowStateStore;
  private workflowEngine?: WorkflowEngine;

  constructor(
    private config: OrchestratorConfig,
    private opts: ServerOpts,
    private agentDefinitions: Map<string, AgentDefinition>,
    private deps: AgentLoopDeps,
    private metrics?: MetricsRegistry
  ) {}

  /** Start the HTTP server */
  async start(): Promise<void> {
    this.taskManager = new TaskManager(
      this.deps,
      this.agentDefinitions,
      this.config.security.maxConcurrentAgents,
      this.config.api?.historyRetention ?? 500
    );

    // Initialize workflow engine if workflows config exists
    if (this.config.workflows) {
      this.workflowStateStore = new WorkflowStateStore(
        this.config.workflows.stateDir
      );
      await this.workflowStateStore.init();

      this.workflowEngine = new WorkflowEngine({
        agentLoopDeps: this.deps,
        stateStore: this.workflowStateStore,
        onCheckpoint: async () => true, // Auto-approve in API mode
      });
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.opts.port, this.opts.host, () => {
        const logger = getLogger();
        logger.info("api.server.started", {
          host: this.opts.host,
          port: this.opts.port,
        });
        // Periodically clean up rate limiter stale entries
        this.cleanupTimer = setInterval(() => this.rateLimiter.cleanup(), 60_000);
        resolve();
      });
    });
  }

  /** Stop the HTTP server */
  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (!this.server) return;
    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ── Request handling ──

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // CORS preflight
    if (method === "OPTIONS" && this.opts.cors) {
      this.setCORS(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // CORS headers for all responses
    if (this.opts.cors) {
      this.setCORS(res);
    }

    // Rate limiting
    const rawIp = req.socket.remoteAddress ?? "unknown";
    const clientIp = rawIp.replace(/^::ffff:/, "");
    if (!this.rateLimiter.allow(clientIp)) {
      this.json(res, 429, { error: "Too many requests" });
      return;
    }

    // Authentication (skip for /api/metrics — Prometheus scrapers don't carry tokens)
    if (this.opts.authToken && path !== "/api/metrics") {
      const auth = req.headers.authorization;
      if (!auth || !this.timingSafeCompare(auth, `Bearer ${this.opts.authToken}`)) {
        this.json(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    // Route matching
    try {
      // Health check
      if (path === "/api/health" && method === "GET") {
        this.json(res, 200, {
          status: "ok",
          agents: this.agentDefinitions.size,
          uptime: process.uptime(),
        });
        return;
      }

      // List agents
      if (path === "/api/agents" && method === "GET") {
        const agents = Array.from(this.agentDefinitions.entries()).map(
          ([type, def]) => ({
            type,
            model: def.model,
            provider: def.provider,
            description: def.description,
            maxSteps: def.maxSteps,
          })
        );
        this.json(res, 200, { agents });
        return;
      }

      // Cost info
      if (path === "/api/cost" && method === "GET") {
        const ct = this.deps.costTracker;
        this.json(res, 200, {
          spent: ct.spent,
          remaining: ct.remaining,
        });
        return;
      }

      // ── Memory endpoints ──

      // List knowledge entries
      if (path === "/api/memory" && method === "GET") {
        if (!this.deps.memory) {
          this.json(res, 404, { error: "Memory not enabled" });
          return;
        }
        const entries = await this.deps.memory.listKnowledge();
        this.json(res, 200, { entries, count: entries.length });
        return;
      }

      // Search knowledge entries
      if (path === "/api/memory/search" && method === "GET") {
        if (!this.deps.memory) {
          this.json(res, 404, { error: "Memory not enabled" });
          return;
        }
        const q = url.searchParams.get("q") ?? "";
        const tagsParam = url.searchParams.get("tags");
        const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
        const results = await this.deps.memory.search(q, tags);
        this.json(res, 200, { results, count: results.length });
        return;
      }

      // Clear knowledge entries
      if (path === "/api/memory" && method === "DELETE") {
        if (!this.deps.memory) {
          this.json(res, 404, { error: "Memory not enabled" });
          return;
        }
        await this.deps.memory.clear();
        this.json(res, 200, { cleared: true });
        return;
      }

      // Prometheus metrics
      if (path === "/api/metrics" && method === "GET") {
        if (!this.metrics) {
          this.json(res, 404, { error: "Metrics not enabled" });
          return;
        }
        const text = this.metrics.export();
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        res.end(text);
        return;
      }

      // Submit task
      if (path === "/api/tasks" && method === "POST") {
        let body: string;
        try {
          body = await this.readBody(req);
        } catch (err) {
          if (err instanceof Error && err.message === "Request body too large") {
            this.json(res, 413, { error: "Request body too large (max 1MB)" });
            return;
          }
          throw err;
        }
        let request: SubmitTaskRequest;
        try {
          request = JSON.parse(body);
        } catch {
          this.json(res, 400, { error: "Invalid JSON" });
          return;
        }

        if (!request.task) {
          this.json(res, 400, { error: "task is required" });
          return;
        }

        const record = this.taskManager!.submit(request);
        this.json(res, 201, {
          id: record.id,
          mode: record.mode,
          status: record.status,
          agentType: record.agentType,
          budget: record.budget,
          createdAt: record.createdAt,
        });
        return;
      }

      // Get task / SSE stream
      const taskMatch = path.match(/^\/api\/tasks\/([a-f0-9-]+)(\/stream)?$/);
      if (taskMatch) {
        const taskId = taskMatch[1];
        const isStream = !!taskMatch[2];
        const record = this.taskManager!.get(taskId);

        if (!record) {
          this.json(res, 404, { error: "Task not found" });
          return;
        }

        if (isStream && method === "GET") {
          // SSE stream
          initSSE(res);
          record.sseClients.add(res);

          // Send current status immediately
          record.sseClients.broadcast("status", {
            taskId: record.id,
            status: record.status,
          });

          // If already completed, send result and close
          if (record.result) {
            record.sseClients.broadcast("result", {
              taskId: record.id,
              ...record.result,
            });
            res.end();
          }
          return;
        }

        if (!isStream && method === "GET") {
          // Task status
          this.json(res, 200, {
            id: record.id,
            task: record.task,
            agentType: record.agentType,
            budget: record.budget,
            status: record.status,
            result: record.result,
            createdAt: record.createdAt,
            startedAt: record.startedAt,
            completedAt: record.completedAt,
          });
          return;
        }
      }

      // ── Workflow endpoints ──

      // Start a workflow
      if (path === "/api/workflows" && method === "POST") {
        if (!this.workflowEngine) {
          this.json(res, 404, { error: "Workflows not enabled" });
          return;
        }

        let body: string;
        try {
          body = await this.readBody(req);
        } catch (err) {
          if (err instanceof Error && err.message === "Request body too large") {
            this.json(res, 413, { error: "Request body too large (max 1MB)" });
            return;
          }
          throw err;
        }

        let request: { file: string; budget?: number; variables?: Record<string, string> };
        try {
          request = JSON.parse(body);
        } catch {
          this.json(res, 400, { error: "Invalid JSON" });
          return;
        }

        if (!request.file) {
          this.json(res, 400, { error: "file is required" });
          return;
        }

        // Load workflow definition
        let definition: WorkflowDefinition;
        try {
          definition = await loadWorkflow(request.file);
        } catch (err) {
          this.json(res, 400, { error: `Failed to load workflow: ${(err as Error).message}` });
          return;
        }

        const budget = request.budget ?? this.config.budget.maxYuan;

        // Create run state first so we can return the ID immediately
        const stateStore = this.workflowStateStore!;
        const stepIds = definition.steps.map((s) => s.id);
        const variables = { ...definition.variables, ...request.variables };
        const initialRun = await stateStore.createRun(definition.name, variables, stepIds);

        // Return 201 immediately with the run ID
        this.json(res, 201, {
          id: initialRun.id,
          workflowName: initialRun.workflowName,
          status: initialRun.status,
          startedAt: initialRun.startedAt,
        });

        // Execute workflow in background
        const engine = this.workflowEngine;
        engine.runWithExisting(initialRun.id, definition, budget).catch((err) => {
          const logger = getLogger();
          logger.error("api.workflow.background_error", {
            runId: initialRun.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }

      // Get workflow run status
      const wfMatch = path.match(/^\/api\/workflows\/([a-z0-9_-]+)$/);
      if (wfMatch && method === "GET") {
        if (!this.workflowStateStore) {
          this.json(res, 404, { error: "Workflows not enabled" });
          return;
        }

        const runId = wfMatch[1];
        const run = await this.workflowStateStore.load(runId);

        if (!run) {
          this.json(res, 404, { error: "Workflow run not found" });
          return;
        }

        this.json(res, 200, {
          id: run.id,
          workflowName: run.workflowName,
          status: run.status,
          steps: run.steps,
          variables: run.variables,
          totalCost: run.totalCost,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          currentStepId: run.currentStepId,
        });
        return;
      }

      // Resume a paused workflow
      const wfResumeMatch = path.match(/^\/api\/workflows\/([a-z0-9_-]+)\/resume$/);
      if (wfResumeMatch && method === "POST") {
        if (!this.workflowEngine) {
          this.json(res, 404, { error: "Workflows not enabled" });
          return;
        }

        const runId = wfResumeMatch[1];
        const existingRun = await this.workflowStateStore!.load(runId);

        if (!existingRun) {
          this.json(res, 404, { error: "Workflow run not found" });
          return;
        }

        if (existingRun.status !== "paused") {
          this.json(res, 400, { error: `Workflow is not paused (status: ${existingRun.status})` });
          return;
        }

        // Need the file path to resume
        let body: string;
        try {
          body = await this.readBody(req);
        } catch {
          body = "{}";
        }

        let request: { file: string; budget?: number };
        try {
          request = JSON.parse(body);
        } catch {
          this.json(res, 400, { error: "Invalid JSON" });
          return;
        }

        if (!request.file) {
          this.json(res, 400, { error: "file is required" });
          return;
        }

        let definition: WorkflowDefinition;
        try {
          definition = await loadWorkflow(request.file);
        } catch (err) {
          this.json(res, 400, { error: `Failed to load workflow: ${(err as Error).message}` });
          return;
        }

        const budget = request.budget ?? this.config.budget.maxYuan;

        try {
          const run = await this.workflowEngine.resumeWithDefinition(runId, definition, budget);

          this.json(res, 200, {
            id: run.id,
            workflowName: run.workflowName,
            status: run.status,
            totalCost: run.totalCost,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
          });
        } catch (err) {
          this.json(res, 500, { error: `Resume failed: ${(err as Error).message}` });
        }
        return;
      }

      // List workflow runs
      if (path === "/api/workflows" && method === "GET") {
        if (!this.workflowStateStore) {
          this.json(res, 404, { error: "Workflows not enabled" });
          return;
        }

        const runs = await this.workflowStateStore.listRuns();
        this.json(res, 200, {
          runs: runs.map((r) => ({
            id: r.id,
            workflowName: r.workflowName,
            status: r.status,
            totalCost: r.totalCost,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
          })),
        });
        return;
      }

      // ── Dashboard / History endpoints ──

      // Global SSE stream for dashboard
      if (path === "/api/dashboard/events" && method === "GET") {
        initSSE(res);
        GlobalSSEClientSet.add(res);
        return;
      }

      // Task history
      if (path === "/api/tasks/history" && method === "GET") {
        if (!this.taskManager) {
          this.json(res, 503, { error: "Task manager not initialized" });
          return;
        }
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit ? Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 200) : 50;
        const statusParam = url.searchParams.get("status");
        const status = statusParam as TaskStatus | undefined;
        const tasks = this.taskManager.listCompleted(limit, status);
        this.json(res, 200, { tasks, count: tasks.length });
        return;
      }

      // 404
      this.json(res, 404, { error: "Not found" });
    } catch (err) {
      const logger = getLogger();
      logger.error("api.request_error", {
        path,
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      this.json(res, 500, { error: "Internal server error" });
    }
  }

  // ── Helpers ──

  private json(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(status, {
      "Content-Type": "application/json",
    });
    res.end(body);
  }

  private setCORS(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  private timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      const maxSize = 1_000_000; // 1MB

      req.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > maxSize) {
          req.destroy();
          reject(new Error("Request body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }
}
