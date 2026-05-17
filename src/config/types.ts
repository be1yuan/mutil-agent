import type { ModelProvider } from "../types/core.js";

export interface ProviderConfig {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  /** Enable provider-native web search tool (e.g. DeepSeek/MiMo web_search) */
  nativeSearch?: boolean;
}

export interface FallbackConfig {
  maxRetries: number;
  retryDelayMs: number;
  retryableErrors: string[];
  fallbackModel?: {
    provider: ModelProvider;
    model: string;
  };
}

export interface SecurityConfig {
  maxConcurrentAgents: number;
  requireApproval: string[];
}

export interface BudgetConfig {
  maxYuan: number;
}

export interface ObservabilityConfig {
  logLevel: "debug" | "info" | "warn" | "error";
  metricsEnabled: boolean;
}

export interface MailboxConfig {
  enabled: boolean;
  /** Directory relative to workspace (default: ".mailbox") */
  dir: string;
  /** Max message age in ms before cleanup (default: 86400000 = 24h) */
  maxAgeMs: number;
  /** Poll interval for waitFor() in ms (default: 500) */
  pollIntervalMs: number;
}

export interface ApiConfig {
  enabled: boolean;
  /** Bind host (default: "127.0.0.1") */
  host: string;
  /** Bind port (default: 3100) */
  port: number;
  /** Optional Bearer token for authentication */
  authToken?: string;
  /** Enable CORS headers (default: true) */
  cors: boolean;
  /** Maximum number of completed tasks to retain in history (default: 500) */
  historyRetention?: number;
  /** Dashboard web server config */
  dashboard?: {
    /** Enable dashboard alongside API server (default: false) */
    enabled?: boolean;
    /** Dashboard web server port (default: 3101) */
    port?: number;
  };
}

export interface WorkflowsConfig {
  /** Directory for workflow YAML files (default: ".workflows") */
  dir: string;
  /** Directory for persisted run state (default: ".workflow-state") */
  stateDir: string;
  /** Default per-step timeout in ms (default: 600000 = 10min) */
  defaultTimeout: number;
  /** Auto-recommend matching workflows when user types a task (default: true) */
  autoRecommend: boolean;
}

export interface MemoryConfig {
  enabled: boolean;
  /** Directory for persisted memory (default: ".memory") */
  dir: string;
  /** Max entries per session (default: 50) */
  shortTermMaxEntries: number;
  /** Max long-term knowledge entries (default: 500) */
  longTermMaxEntries: number;
  /** Token count threshold for auto-summarization (default: 8000) */
  summarizationThreshold: number;
  /** Auto-generate conversation summaries (default: true) */
  autoSummarize: boolean;
}

export interface DebateGlobalConfig {
  /** Default judge agent type (default: "judge") */
  defaultJudgeAgent: string;
  /** Default number of debate rounds (default: 2) */
  defaultRounds: number;
  /** Enable judge scoring by default (default: true) */
  scoringEnabled: boolean;
  /** Default participants (default: ["explore", "architect"]) */
  defaultParticipants: string[];
  /** Default moderator agent type (default: "" = none) */
  defaultModerator: string;
}

export interface ReviewChainGlobalConfig {
  /** Default coder agent type (default: "coder") */
  defaultCoder: string;
  /** Default reviewer agent type (default: "reviewer") */
  defaultReviewer: string;
  /** Default max iterations (default: 3) */
  defaultMaxIterations: number;
  /** Default acceptance mode (default: "auto") */
  defaultAcceptThreshold: "auto" | "manual";
}

export interface OrchestratorConfig {
  providers: Record<ModelProvider, ProviderConfig>;
  fallback: FallbackConfig;
  security: SecurityConfig;
  budget: BudgetConfig;
  observability: ObservabilityConfig;
  mailbox?: MailboxConfig;
  api?: ApiConfig;
  workflows?: WorkflowsConfig;
  memory?: MemoryConfig;
  debate?: DebateGlobalConfig;
  reviewChain?: ReviewChainGlobalConfig;
}

/** Default config values */
export const DEFAULT_CONFIG: Partial<OrchestratorConfig> = {
  fallback: {
    maxRetries: 3,
    retryDelayMs: 1000,
    retryableErrors: ["rate_limit", "timeout", "server_error"],
  },
  security: {
    maxConcurrentAgents: 5,
    requireApproval: [],
  },
  budget: {
    maxYuan: 35.0,
  },
  observability: {
    logLevel: "info",
    metricsEnabled: true,
  },
  mailbox: {
    enabled: true,
    dir: ".mailbox",
    maxAgeMs: 86_400_000,
    pollIntervalMs: 500,
  },
  api: {
    enabled: true,
    host: "127.0.0.1",
    port: 3100,
    cors: true,
  },
  workflows: {
    dir: ".workflows",
    stateDir: ".workflow-state",
    defaultTimeout: 600_000,
    autoRecommend: true,
  },
  memory: {
    enabled: true,
    dir: ".memory",
    shortTermMaxEntries: 50,
    longTermMaxEntries: 500,
    summarizationThreshold: 8000,
    autoSummarize: true,
  },
  debate: {
    defaultJudgeAgent: "judge",
    defaultRounds: 2,
    scoringEnabled: true,
    defaultParticipants: ["explore", "architect"],
    defaultModerator: "",
  },
  reviewChain: {
    defaultCoder: "coder",
    defaultReviewer: "reviewer",
    defaultMaxIterations: 3,
    defaultAcceptThreshold: "auto",
  },
};
