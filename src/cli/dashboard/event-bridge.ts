/**
 * Event bridge — connects AgentLoopDeps lifecycle callbacks
 * to a Node.js EventEmitter that the Dashboard UI subscribes to.
 *
 * Also manages the approval flow: when onApprovalRequest is called,
 * the bridge emits an "approval" event and returns a Promise that
 * resolves when the Dashboard user presses A (approve) or D (deny).
 */

import { EventEmitter } from "node:events";
import type { AgentLoopDeps } from "../../agent/agent-loop.js";
import type { SubAgentResult } from "../../adapters/types.js";
import type {
  DashboardEvent,
  StepEventData,
  ToolStartEventData,
  ToolCompleteEventData,
  SubAgentSpawnEventData,
  SubAgentCompleteEventData,
  BudgetEventData,
  StreamEventData,
  ApprovalEventData,
} from "./types.js";

/** Tracks a pending approval request that the Dashboard can resolve */
interface PendingApproval {
  id: number;
  resolve: (approved: boolean) => void;
}

/** User action from the post-task menu */
export type UserAction =
  | { type: "continue"; message: string }
  | { type: "save" }
  | { type: "exit" };

export class DashboardEventBridge extends EventEmitter {
  private approvalCounter = 0;
  private pendingApproval: PendingApproval | null = null;
  private lastBudgetEmit = 0;
  private static BUDGET_THROTTLE_MS = 200;
  private userActionResolve: ((action: UserAction) => void) | null = null;

  /**
   * Create an AgentLoopDeps with all lifecycle callbacks wired
   * to emit DashboardEvents through this bridge.
   *
   * Existing callbacks in baseDeps are preserved — the bridge
   * callbacks call the originals first, then emit.
   *
   * onApprovalRequest is overridden to emit an "approval" event
   * and return a Promise that resolves when the Dashboard user
   * approves or denies the request.
   */
  createDeps(baseDeps: AgentLoopDeps): AgentLoopDeps {
    const bridge = this;
    const emit = (type: DashboardEvent["type"], data: DashboardEvent["data"]) => {
      bridge.emit("event", { type, data, timestamp: Date.now() } as DashboardEvent);
    };

    return {
      ...baseDeps,

      onStreamText: (text: string) => {
        baseDeps.onStreamText?.(text);
        emit("stream", { text } as StreamEventData);
      },

      onStepStart: (step: number, agentType: string) => {
        baseDeps.onStepStart?.(step, agentType);
        emit("step", { step, agentType } as StepEventData);
      },

      onToolStart: (agentType: string, toolName: string, args: Record<string, unknown>) => {
        baseDeps.onToolStart?.(agentType, toolName, args);
        emit("tool_start", { agentType, toolName, args } as ToolStartEventData);
      },

      onToolComplete: (agentType: string, toolName: string, duration: number, success: boolean) => {
        baseDeps.onToolComplete?.(agentType, toolName, duration, success);
        emit("tool_complete", { agentType, toolName, duration, success } as ToolCompleteEventData);
      },

      onSubAgentSpawn: (parent: string, child: string, task: string) => {
        baseDeps.onSubAgentSpawn?.(parent, child, task);
        emit("subagent_spawn", { parent, child, task } as SubAgentSpawnEventData);
      },

      onSubAgentComplete: (parent: string, child: string, result: SubAgentResult) => {
        baseDeps.onSubAgentComplete?.(parent, child, result);
        emit("subagent_complete", {
          parent,
          child,
          result: { status: result.status, steps: result.steps, cost: result.cost },
        } as SubAgentCompleteEventData);
      },

      onBudgetUpdate: (spent: number, remaining: number) => {
        baseDeps.onBudgetUpdate?.(spent, remaining);
        // Throttle budget events to avoid excessive re-renders
        const now = Date.now();
        if (now - bridge.lastBudgetEmit >= DashboardEventBridge.BUDGET_THROTTLE_MS) {
          bridge.lastBudgetEmit = now;
          emit("budget", { spent, remaining } as BudgetEventData);
        }
      },

      // Approval flow: emit event and return a Promise that resolves
      // when the Dashboard user approves or denies via keyboard.
      onApprovalRequest: (req: { agentType: string; toolName: string; arguments: Record<string, unknown> }) => {
        const id = ++bridge.approvalCounter;
        emit("approval", {
          id,
          agentType: req.agentType,
          toolName: req.toolName,
          args: req.arguments,
        } as ApprovalEventData & { id: number });

        return new Promise<boolean>((resolve) => {
          bridge.pendingApproval = { id, resolve };
        });
      },
    };
  }

  /** Resolve the current pending approval (called by Dashboard keyboard handler) */
  resolveApproval(approved: boolean): void {
    if (this.pendingApproval) {
      const { resolve } = this.pendingApproval;
      this.pendingApproval = null;
      resolve(approved);
    }
  }

  /** Get the current pending approval ID (for Dashboard to check) */
  getPendingApprovalId(): number | null {
    return this.pendingApproval?.id ?? null;
  }

  /** Emit an approval event for the dashboard to display (external use) */
  emitApprovalRequest(agentType: string, toolName: string, args: Record<string, unknown>): void {
    const id = ++this.approvalCounter;
    this.emit("event", {
      type: "approval",
      data: { id, agentType, toolName, args } as ApprovalEventData & { id: number },
      timestamp: Date.now(),
    });
  }

  /** Emit a "done" event when the agent loop finishes */
  emitDone(status: string, steps: number, cost: number, content?: string): void {
    // Flush final budget event before done (bypass throttle)
    this.lastBudgetEmit = 0;
    this.emit("event", {
      type: "budget",
      data: { spent: cost, remaining: 0 } as BudgetEventData,
      timestamp: Date.now(),
    });
    this.emit("event", {
      type: "done",
      data: { status, steps, cost, content },
      timestamp: Date.now(),
    });
  }

  /** Wait for user to choose a post-task action (continue / save / exit) */
  waitForUserAction(): Promise<UserAction> {
    return new Promise((resolve) => {
      this.userActionResolve = resolve;
    });
  }

  /** Resolve the pending user action (called by Dashboard keyboard handler) */
  resolveUserAction(action: UserAction): void {
    if (this.userActionResolve) {
      const resolve = this.userActionResolve;
      this.userActionResolve = null;
      resolve(action);
    }
  }

  /** Reset state for a new conversation round */
  resetForContinuation(): void {
    this.pendingApproval = null;
    this.lastBudgetEmit = 0;
  }
}
