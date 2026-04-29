/**
 * Task manager for the HTTP API.
 *
 * Tracks task lifecycle: submitted → queued → running → completed/failed/budget_exceeded
 * Supports SSE event broadcasting for real-time updates.
 */

import crypto from "node:crypto";
import type { AgentResult } from "../types/core.js";
import type { AgentLoopDeps } from "../agent/agent-loop.js";
import type { AgentDefinition } from "../agent/types.js";
import { AgentLoop } from "../agent/agent-loop.js";
import { CostTracker } from "../observability/cost-tracker.js";
import { SSEClientSet } from "./sse.js";
import { getLogger } from "../observability/logger.js";

// ── Types ──

export type TaskStatus =
  | "submitted"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "budget_exceeded";

export interface TaskRecord {
  id: string;
  task: string;
  agentType: string;
  budget: number;
  status: TaskStatus;
  result?: AgentResult;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** SSE clients subscribed to this task */
  sseClients: SSEClientSet;
}

export interface SubmitTaskRequest {
  task: string;
  agentType?: string;
  budget?: number;
}

// ── Task Manager ──

export class TaskManager {
  private tasks = new Map<string, TaskRecord>();
  private queue: string[] = [];
  private maxConcurrent: number;
  private runningCount = 0;
  private deps: AgentLoopDeps;
  private agentDefinitions: Map<string, AgentDefinition>;

  constructor(
    deps: AgentLoopDeps,
    agentDefinitions: Map<string, AgentDefinition>,
    maxConcurrent: number = 3
  ) {
    this.deps = deps;
    this.agentDefinitions = agentDefinitions;
    this.maxConcurrent = maxConcurrent;
  }

  /** Submit a new task. Returns the task record. */
  submit(request: SubmitTaskRequest): TaskRecord {
    const id = crypto.randomUUID();
    const agentType = request.agentType ?? "main";
    const budget = request.budget ?? this.deps.costTracker.budgetAmount;

    const record: TaskRecord = {
      id,
      task: request.task,
      agentType,
      budget,
      status: "submitted",
      createdAt: Date.now(),
      sseClients: new SSEClientSet(),
    };

    this.tasks.set(id, record);
    this.queue.push(id);
    record.status = "queued";

    // Broadcast task creation
    record.sseClients.broadcast("status", { taskId: id, status: "queued" });

    // Try to start immediately
    this.processQueue();

    return record;
  }

  /** Get a task by ID */
  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  /** List all tasks, optionally filtered by status */
  list(status?: TaskStatus): TaskRecord[] {
    const all = Array.from(this.tasks.values());
    if (status) return all.filter((t) => t.status === status);
    return all;
  }

  /** Get SSE client set for a task */
  getSSEClients(taskId: string): SSEClientSet | undefined {
    return this.tasks.get(taskId)?.sseClients;
  }

  /** Process the task queue */
  private processQueue(): void {
    while (this.runningCount < this.maxConcurrent && this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      const record = this.tasks.get(taskId);
      if (!record) continue;

      this.runningCount++;
      this.executeTask(record);
    }
  }

  /** Execute a task in the background */
  private async executeTask(record: TaskRecord): Promise<void> {
    const logger = getLogger();
    const definition = this.agentDefinitions.get(record.agentType);

    if (!definition) {
      record.status = "failed";
      record.result = {
        status: "error",
        error: `Agent "${record.agentType}" not found`,
        steps: 0,
        cost: 0,
      };
      record.completedAt = Date.now();
      record.sseClients.broadcast("result", record.result);
      record.sseClients.closeAll();
      this.runningCount--;
      this.processQueue();
      return;
    }

    record.status = "running";
    record.startedAt = Date.now();

    record.sseClients.broadcast("status", {
      taskId: record.id,
      status: "running",
    });

    // Build deps with per-task CostTracker (avoids global budget competition)
    const taskCostTracker = new CostTracker(record.budget);
    const sseDeps: AgentLoopDeps = {
      ...this.deps,
      costTracker: taskCostTracker,
      onStepStart: (step: number, agentType: string) => {
        this.deps.onStepStart?.(step, agentType);
        record.sseClients.broadcast("step", {
          taskId: record.id,
          step,
          maxSteps: definition.maxSteps,
          agentType,
        });
      },
      onToolStart: (agentType: string, toolName: string, args: Record<string, unknown>) => {
        this.deps.onToolStart?.(agentType, toolName, args);
        record.sseClients.broadcast("tool", {
          taskId: record.id,
          name: toolName,
          args,
          status: "start",
        });
      },
      onToolComplete: (agentType: string, toolName: string, duration: number, success: boolean) => {
        this.deps.onToolComplete?.(agentType, toolName, duration, success);
        record.sseClients.broadcast("tool", {
          taskId: record.id,
          name: toolName,
          duration,
          success,
          status: "complete",
        });
      },
      onStreamText: (text: string) => {
        this.deps.onStreamText?.(text);
        record.sseClients.broadcast("delta", {
          taskId: record.id,
          text,
        });
      },
      onBudgetUpdate: (spent: number, remaining: number) => {
        this.deps.onBudgetUpdate?.(spent, remaining);
        record.sseClients.broadcast("cost", {
          taskId: record.id,
          spent,
          remaining,
        });
      },
    };

    try {
      const loop = new AgentLoop(sseDeps);
      const result = await loop.run(record.task, definition, record.budget);

      record.result = result;
      record.status = this.mapStatus(result.status);
      record.completedAt = Date.now();

      logger.info("api.task.completed", {
        taskId: record.id,
        status: record.status,
        steps: result.steps,
        cost: result.cost,
      });

      record.sseClients.broadcast("result", {
        taskId: record.id,
        ...result,
      });
    } catch (err) {
      record.status = "failed";
      record.result = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        steps: 0,
        cost: 0,
      };
      record.completedAt = Date.now();

      record.sseClients.broadcast("result", {
        taskId: record.id,
        ...record.result,
      });
    } finally {
      record.sseClients.closeAll();
      this.runningCount--;
      this.processQueue();
    }
  }

  /** Map AgentResult status to TaskStatus */
  private mapStatus(s: string): TaskStatus {
    switch (s) {
      case "success":
        return "completed";
      case "budget_exceeded":
        return "budget_exceeded";
      default:
        return "failed";
    }
  }
}
