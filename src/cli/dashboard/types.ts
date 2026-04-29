/**
 * Dashboard-specific type definitions.
 * Shared types for the interactive TUI dashboard components.
 */

/** All dashboard event types emitted by the event bridge */
export type DashboardEventType =
  | "step"
  | "tool_start"
  | "tool_complete"
  | "subagent_spawn"
  | "subagent_complete"
  | "budget"
  | "stream"
  | "approval"
  | "done";

/** Base shape for every dashboard event */
export interface DashboardEvent {
  type: DashboardEventType;
  data: unknown;
  timestamp: number;
}

/** Data payloads for each event type */
export interface StepEventData {
  step: number;
  agentType: string;
}

export interface ToolStartEventData {
  agentType: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolCompleteEventData {
  agentType: string;
  toolName: string;
  duration: number;
  success: boolean;
}

export interface SubAgentSpawnEventData {
  parent: string;
  child: string;
  task: string;
}

export interface SubAgentCompleteEventData {
  parent: string;
  child: string;
  result: {
    status: string;
    steps: number;
    cost: number;
  };
}

export interface BudgetEventData {
  spent: number;
  remaining: number;
}

export interface StreamEventData {
  text: string;
}

export interface ApprovalEventData {
  id: number;
  agentType: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface DoneEventData {
  status: string;
  content?: string;
  steps: number;
  cost: number;
}

/** Agent status tracked by the dashboard */
export type AgentStatus = "running" | "done" | "waiting" | "error";

/** Per-agent info kept in dashboard state */
export interface AgentInfo {
  agentType: string;
  status: AgentStatus;
  steps: number;
  parentType?: string;
}

/** Output line for the scrolling output panel */
export interface OutputLine {
  id: number;
  text: string;
  type: "stream" | "tool" | "step" | "system";
  timestamp: number;
}

/** Approval request displayed in the approval bar */
export interface ApprovalRequest {
  id: number;
  agentType: string;
  toolName: string;
  args: Record<string, unknown>;
}
