import { z } from "zod";
import type { OrchestratorConfig } from "./types.js";

// ── Schemas ──

const ProviderConfigSchema = z.object({
  apiKey: z.string().min(1, "API Key is required"),
  baseURL: z.string().url("Must be a valid URL"),
  defaultModel: z.string().min(1, "Default model is required"),
  nativeSearch: z.boolean().optional(),
});

const FallbackConfigSchema = z.object({
  maxRetries: z.number().int().min(0).default(3),
  retryDelayMs: z.number().int().min(0).default(1000),
  retryableErrors: z.array(z.string()).default(["rate_limit", "timeout", "server_error"]),
  fallbackModel: z
    .object({
      provider: z.enum(["deepseek", "zhipu", "mimo"]),
      model: z.string().min(1),
    })
    .optional(),
});

const SecurityConfigSchema = z.object({
  maxConcurrentAgents: z.number().int().min(1).max(20).default(5),
  requireApproval: z.array(z.string()).default([]),
});

const BudgetConfigSchema = z.object({
  maxYuan: z.number().positive().default(35.0),
});

const ObservabilityConfigSchema = z.object({
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  metricsEnabled: z.boolean().default(true),
});

const MailboxConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().default(".mailbox"),
  maxAgeMs: z.number().int().min(1000).default(86_400_000),
  pollIntervalMs: z.number().int().min(50).default(500),
});

const ApiConfigSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3100),
  authToken: z.string().optional(),
  cors: z.boolean().default(true),
});

const WorkflowsConfigSchema = z.object({
  dir: z.string().default(".workflows"),
  stateDir: z.string().default(".workflow-state"),
  defaultTimeout: z.number().int().min(1000).default(600_000),
  autoRecommend: z.boolean().default(true),
});

const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().default(".memory"),
  shortTermMaxEntries: z.number().int().min(1).default(50),
  longTermMaxEntries: z.number().int().min(1).default(500),
  summarizationThreshold: z.number().int().min(1000).default(8000),
  autoSummarize: z.boolean().default(true),
});

const ConfigSchema = z.object({
  providers: z.record(z.enum(["deepseek", "zhipu", "mimo"]), ProviderConfigSchema).refine(
    (p) => Object.keys(p).length >= 1,
    "At least one provider is required"
  ),
  fallback: FallbackConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  budget: BudgetConfigSchema.default({}),
  observability: ObservabilityConfigSchema.default({}),
  mailbox: MailboxConfigSchema.default({}).optional(),
  api: ApiConfigSchema.default({}).optional(),
  workflows: WorkflowsConfigSchema.default({}).optional(),
  memory: MemoryConfigSchema.default({}).optional(),
});

// ── Validation ──

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigValidationError";
  }
}

export function validateConfig(raw: unknown): OrchestratorConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigValidationError(issues);
  }
  return result.data as OrchestratorConfig;
}
