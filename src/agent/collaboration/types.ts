// ── 评分类型 ──

export interface DebateScoreDimensions {
  relevance: number;
  depth: number;
  novelty: number;
  critique: number;
  clarity: number;
}

export interface DebateParticipantScore {
  agentType: string;
  totalScore: number;
  dimensions: DebateScoreDimensions;
  comment: string;
}

// ── 辩论 ──

export interface DebateConfig {
  participants: string[];
  rounds: number;
  moderator?: string;
  judge: boolean;
  judgeAgentType?: string;
  prompt: string;
  /** Custom judge prompt template. Use {topic} and {responses} placeholders. Overrides the default dimensions. */
  customJudgePrompt?: string;
}

export interface DebateRoundResult {
  round: number;
  responses: Array<{ agentType: string; content: string; steps: number; cost: number }>;
  scores?: DebateParticipantScore[];
}

export interface DebateResult {
  status: "success" | "error" | "partial" | "budget_exceeded";
  content?: string;
  rounds: DebateRoundResult[];
  moderatorResult?: { agentType: string; content: string };
  totalCost: number;
  totalSteps: number;
}

// ── 审查链 ──

export interface ReviewChainConfig {
  coder: string;
  reviewer: string;
  maxIterations: number;
  acceptThreshold: "auto" | "manual";
}

export type ReviewVerdict =
  | { type: "LGTM" | "APPROVED" }
  | { type: "NEEDS_CHANGES"; feedback: string };

export interface ReviewChainIteration {
  iteration: number;
  coderResult: { content: string; cost: number; steps: number };
  reviewerResult?: { content: string; cost: number; steps: number; verdict: ReviewVerdict };
  accepted: boolean;
  feedback?: string;
}

export interface ReviewChainResult {
  status: "success" | "error" | "budget_exceeded" | "max_iterations_reached";
  content?: string;
  iterations: ReviewChainIteration[];
  totalCost: number;
  totalSteps: number;
}
