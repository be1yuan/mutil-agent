import type { ModelProvider } from "../types/core.js";

export interface ProviderConfig {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
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
}

export interface OrchestratorConfig {
  providers: Record<ModelProvider, ProviderConfig>;
  fallback: FallbackConfig;
  security: SecurityConfig;
  budget: BudgetConfig;
  observability: ObservabilityConfig;
  mailbox?: MailboxConfig;
  api?: ApiConfig;
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
};
