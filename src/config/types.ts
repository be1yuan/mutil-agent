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
  maxDollars: number;
}

export interface ObservabilityConfig {
  logLevel: "debug" | "info" | "warn" | "error";
  metricsEnabled: boolean;
}

export interface OrchestratorConfig {
  providers: Record<ModelProvider, ProviderConfig>;
  fallback: FallbackConfig;
  security: SecurityConfig;
  budget: BudgetConfig;
  observability: ObservabilityConfig;
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
    maxDollars: 5.0,
  },
  observability: {
    logLevel: "info",
    metricsEnabled: true,
  },
};
