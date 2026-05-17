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
import type { DebateConfig, ReviewChainConfig } from "../agent/collaboration/types.js";
import { AgentLoop } from "../agent/agent-loop.js";
import { Committee, type CommitteeConfig } from "../agent/committee.js";
import { Debate } from "../agent/collaboration/debate.js";
import { ReviewChain } from "../agent/collaboration/review-chain.js";
import { CostTracker } from "../observability/cost-tracker.js";
import { SSEClientSet, GlobalSSEClientSet } from "./sse.js";
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
  mode: string;
  budget: number;
  status: TaskStatus;
  result?: AgentResult;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** SSE clients subscribed to this task */
  sseClients: SSEClientSet;
  /** User-provided mode configs (from SubmitTaskRequest) */
  debateConfig?: DebateConfig;
  reviewChainConfig?: ReviewChainConfig;
  committeeConfig?: {
    agentTypes: string[];
    strategy?: string;
    weights?: Record<string, number>;
  };
}

export interface SubmitTaskRequest {
  task: string;
  agentType?: string;
  budget?: number;
  mode?: "single" | "debate" | "review-chain" | "committee";
  debateConfig?: DebateConfig;
  reviewChainConfig?: ReviewChainConfig;
  committeeConfig?: {
    agentTypes: string[];
    strategy?: string;
    weights?: Record<string, number>;
  };
}

// ── Task Manager ──

export class TaskManager {
  private tasks = new Map<string, TaskRecord>();
  private queue: string[] = [];
  private completedTasks: TaskRecord[] = [];
  private maxConcurrent: number;
  private historyRetention: number;
  private runningCount = 0;
  private deps: AgentLoopDeps;
  private agentDefinitions: Map<string, AgentDefinition>;

  constructor(
    deps: AgentLoopDeps,
    agentDefinitions: Map<string, AgentDefinition>,
    maxConcurrent: number = 3,
    historyRetention: number = 500
  ) {
    this.deps = deps;
    this.agentDefinitions = agentDefinitions;
    this.maxConcurrent = maxConcurrent;
    this.historyRetention = historyRetention;
  }

  /** Submit a new task. Returns the task record. */
  submit(request: SubmitTaskRequest): TaskRecord {
    const id = crypto.randomUUID();
    const mode = request.mode ?? "single";
    const agentType = mode === "single" ? (request.agentType ?? "main") : mode;
    const budget = request.budget ?? this.deps.costTracker.budgetAmount;

    const record: TaskRecord = {
      id,
      task: request.task,
      agentType,
      mode,
      budget,
      status: "submitted",
      createdAt: Date.now(),
      sseClients: new SSEClientSet(),
      debateConfig: request.debateConfig,
      reviewChainConfig: request.reviewChainConfig,
      committeeConfig: request.committeeConfig,
    };

    this.tasks.set(id, record);
    this.queue.push(id);
    record.status = "queued";

    // Broadcast task creation
    record.sseClients.broadcast("status", { taskId: id, status: "queued" });
    GlobalSSEClientSet.broadcast("task", { taskId: id, task: record.task, mode: record.mode, status: "queued", createdAt: record.createdAt });

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

  /** List completed/failed tasks (history), optionally filtered by status */
  listCompleted(limit: number = 50, status?: TaskStatus): TaskRecord[] {
    const filtered = status
      ? this.completedTasks.filter((t) => t.status === status)
      : this.completedTasks;
    return filtered.slice(-limit).reverse(); // newest first
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

    record.status = "running";
    record.startedAt = Date.now();

    record.sseClients.broadcast("status", {
      taskId: record.id,
      status: "running",
    });
    GlobalSSEClientSet.broadcast("task", { taskId: record.id, task: record.task, mode: record.mode, status: "running", startedAt: record.startedAt });

    // Build deps with per-task CostTracker (avoids global budget competition)
    const taskCostTracker = new CostTracker(record.budget);
    const sseDeps: AgentLoopDeps = {
      ...this.deps,
      costTracker: taskCostTracker,
      onStepStart: (step: number, agentType: string) => {
        this.deps.onStepStart?.(step, agentType);
        record.sseClients.broadcast("step", { taskId: record.id, step, agentType });
      },
      onToolStart: (agentType: string, toolName: string, args: Record<string, unknown>) => {
        this.deps.onToolStart?.(agentType, toolName, args);
        record.sseClients.broadcast("tool", { taskId: record.id, name: toolName, args, status: "start" });
      },
      onToolComplete: (agentType: string, toolName: string, duration: number, success: boolean) => {
        this.deps.onToolComplete?.(agentType, toolName, duration, success);
        record.sseClients.broadcast("tool", { taskId: record.id, name: toolName, duration, success, status: "complete" });
      },
      onStreamText: (text: string) => {
        this.deps.onStreamText?.(text);
        record.sseClients.broadcast("delta", { taskId: record.id, text });
      },
      onBudgetUpdate: (spent: number, remaining: number) => {
        this.deps.onBudgetUpdate?.(spent, remaining);
        record.sseClients.broadcast("cost", { taskId: record.id, spent, remaining });
        GlobalSSEClientSet.broadcast("cost", { taskId: record.id, spent, remaining });
      },
    };

    try {
      let result: AgentResult;

      switch (record.mode) {
        case "debate": {
          const config = this.resolveDebateConfig(record);
          const debate = new Debate(sseDeps);
          const debateResult = await debate.run(record.task, config, record.budget);
          result = { status: debateResult.status as AgentResult["status"], content: debateResult.content, steps: debateResult.totalSteps, cost: debateResult.totalCost };
          break;
        }
        case "review-chain": {
          const config = this.resolveReviewChainConfig(record);
          const chain = new ReviewChain(sseDeps);
          const chainResult = await chain.run(record.task, config, record.budget);
          result = { status: chainResult.status as AgentResult["status"], content: chainResult.content, steps: chainResult.totalSteps, cost: chainResult.totalCost };
          break;
        }
        case "committee": {
          const config = this.resolveCommitteeConfig(record);
          const committee = new Committee(sseDeps);
          const committeeResult = await committee.run(record.task, config, record.budget);
          result = { status: committeeResult.status as AgentResult["status"], content: committeeResult.content, steps: committeeResult.totalSteps, cost: committeeResult.totalCost };
          break;
        }
        default: {
          const definition = this.agentDefinitions.get(record.agentType);
          if (!definition) {
            throw new Error(`Agent "${record.agentType}" not found`);
          }
          const loop = new AgentLoop(sseDeps);
          result = await loop.run(record.task, definition, record.budget);
        }
      }

      record.result = result;
      record.status = this.mapStatus(result.status);
      record.completedAt = Date.now();

      logger.info("api.task.completed", {
        taskId: record.id,
        mode: record.mode,
        status: record.status,
        steps: result.steps,
        cost: result.cost,
      });

      record.sseClients.broadcast("result", { taskId: record.id, ...result });
      GlobalSSEClientSet.broadcast("result", { taskId: record.id, status: record.status, result });
      this.archiveCompleted(record);
    } catch (err) {
      record.status = "failed";
      record.result = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        steps: 0,
        cost: 0,
      };
      record.completedAt = Date.now();
      record.sseClients.broadcast("result", { taskId: record.id, ...record.result });
      GlobalSSEClientSet.broadcast("result", { taskId: record.id, status: "failed", result: record.result });
      this.archiveCompleted(record);
    } finally {
      record.sseClients.closeAll();
      this.runningCount--;
      this.processQueue();
    }
  }

  /** Resolve debate config — user-provided config takes priority, falls back to defaults */
  private resolveDebateConfig(record: TaskRecord): DebateConfig {
    if (record.debateConfig) {
      return record.debateConfig;
    }
    return {
      participants: ["explore", "architect"],
      rounds: 2,
      judge: true,
      prompt: record.task,
    };
  }

  /** Resolve review-chain config — user-provided config takes priority, falls back to defaults */
  private resolveReviewChainConfig(record: TaskRecord): ReviewChainConfig {
    if (record.reviewChainConfig) {
      return record.reviewChainConfig;
    }
    return {
      coder: "coder",
      reviewer: "reviewer",
      maxIterations: 3,
      acceptThreshold: "auto",
    };
  }

  /** Resolve committee config — user-provided config takes priority, falls back to defaults */
  private resolveCommitteeConfig(record: TaskRecord): CommitteeConfig {
    if (record.committeeConfig) {
      return {
        agentTypes: record.committeeConfig.agentTypes,
        strategy: record.committeeConfig.strategy as CommitteeConfig["strategy"] ?? "concat",
        ...(record.committeeConfig.weights ? { weights: record.committeeConfig.weights } : {}),
      };
    }
    return {
      agentTypes: ["explore", "coder", "reviewer", "architect"],
      strategy: "concat",
    };
  }

  /** Archive a completed or failed task to history, trimming to retention limit */
  private archiveCompleted(record: TaskRecord): void {
    this.completedTasks.push({ ...record });
    if (this.completedTasks.length > this.historyRetention) {
      this.completedTasks = this.completedTasks.slice(-this.historyRetention);
    }
  }

  /** Map AgentResult status to TaskStatus */
  private mapStatus(s: string): TaskStatus {
    switch (s) {
      case "success":
        return "completed";
      case "budget_exceeded":
        return "budget_exceeded";
      case "max_iterations_reached":
      case "partial":
        return "completed"; // partial success is still "completed" from API perspective
      default:
        return "failed";
    }
  }
}
