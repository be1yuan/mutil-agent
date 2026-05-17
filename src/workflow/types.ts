/**
 * Workflow Engine types — Phase 1 of v2.0.
 *
 * Defines the YAML workflow format, step execution model,
 * conditional branching, and checkpoint/pause-resume semantics.
 */

import type { AgentResult, ModelProvider } from "../types/core.js";
import type { DebateConfig, ReviewChainConfig } from "../agent/collaboration/types.js";

// ── Step types ──

export type StepType = "agent" | "committee" | "checkpoint" | "debate" | "review-chain";

export interface WorkflowCondition {
  field: "status" | "content" | "cost";
  operator: "eq" | "contains" | "gt" | "lt" | "matches";
  value: string | number;
}

export interface WorkflowStep {
  id: string;
  type: StepType;
  agentType?: string;          // type=agent
  agentTypes?: string[];       // type=committee
  task: string;                // supports ${var} and ${steps.id.content} interpolation
  model?: string;              // override agent's default model for this step
  provider?: ModelProvider;    // override agent's default provider for this step
  maxSteps?: number;
  budget?: number;             // per-step budget cap (yuan)
  timeout?: number;            // per-step timeout (ms)
  strategy?: string;           // committee aggregation strategy
  debateConfig?: DebateConfig;  // type=debate
  reviewChainConfig?: ReviewChainConfig; // type=review-chain
  on?: {
    condition: WorkflowCondition;
    then: string;              // next step id on match
    else: string;              // branch id on non-match
  };
  checkpoint?: {
    message: string;
    autoApprove?: boolean;     // auto-approve in non-interactive mode
  };
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  version?: string;
  steps: WorkflowStep[];
  variables?: Record<string, string>;
}

// ── Runtime state ──

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "waiting_approval";

export interface StepResult {
  stepId: string;
  status: StepStatus;
  result?: AgentResult;
  startedAt?: number;
  completedAt?: number;
  approved?: boolean;
}

export type WorkflowStatus = "running" | "completed" | "failed" | "paused" | "cancelled";

export interface WorkflowRun {
  id: string;
  workflowName: string;
  status: WorkflowStatus;
  steps: StepResult[];
  variables: Record<string, string>;
  startedAt: number;
  completedAt?: number;
  totalCost: number;
  currentStepId?: string;
}
