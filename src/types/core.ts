// Core shared types — no dependencies

export type ModelProvider = "deepseek" | "zhipu" | "mimo";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StopReason {
  type: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "refusal";
}

export interface AgentResult {
  status: "success" | "error" | "budget_exceeded" | "max_steps_reached";
  content?: string;
  error?: string;
  steps: number;
  cost: number;
}
