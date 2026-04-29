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

import http from "node:http";
import type { ServerResponse, IncomingMessage } from "node:http";
import type { OrchestratorConfig } from "../config/types.js";
import type { AgentDefinition } from "../agent/types.js";
import type { CostTracker } from "../observability/cost-tracker.js";
import type { Mailbox } from "../agent/mailbox.js";
import { TaskManager, type SubmitTaskRequest } from "./task-manager.js";
import { AgentLoopDeps } from "../agent/agent-loop.js";
import { initSSE } from "./sse.js";
import { getLogger } from "../observability/logger.js";

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

  constructor(
    private config: OrchestratorConfig,
    private opts: ServerOpts,
    private agentDefinitions: Map<string, AgentDefinition>,
    private deps: AgentLoopDeps
  ) {}

  /** Start the HTTP server */
  async start(): Promise<void> {
    this.taskManager = new TaskManager(
      this.deps,
      this.agentDefinitions,
      this.config.security.maxConcurrentAgents
    );

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
    const clientIp = req.socket.remoteAddress ?? "unknown";
    if (!this.rateLimiter.allow(clientIp)) {
      this.json(res, 429, { error: "Too many requests" });
      return;
    }

    // Authentication
    if (this.opts.authToken) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${this.opts.authToken}`) {
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
        const request = JSON.parse(body) as SubmitTaskRequest;

        if (!request.task) {
          this.json(res, 400, { error: "task is required" });
          return;
        }

        const record = this.taskManager!.submit(request);
        this.json(res, 201, {
          id: record.id,
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
