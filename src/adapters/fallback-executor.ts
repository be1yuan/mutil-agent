import type {
  ModelAdapter,
  ChatParams,
  ChatResponse,
  FallbackPolicy,
} from "./types.js";
import type { ModelProvider } from "../types/core.js";

// ── Errors ──

export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

// ── Fallback executor ──

export class FallbackExecutor {
  constructor(
    private adapters: Map<ModelProvider, ModelAdapter>,
    private policy: FallbackPolicy
  ) {}

  async execute(
    params: ChatParams,
    provider: ModelProvider
  ): Promise<ChatResponse> {
    let lastError: Error | undefined;
    let currentProvider = provider;
    let currentModel = params.model;

    // Primary model retries
    for (let attempt = 0; attempt <= this.policy.maxRetries; attempt++) {
      try {
        const adapter = this.adapters.get(currentProvider);
        if (!adapter) {
          throw new Error(`No adapter found for provider: ${currentProvider}`);
        }
        // Streaming params (stream, onTextDelta) are passed through transparently.
        // The adapter's chat() method handles streaming internally when stream=true.
        // NOTE: If retry occurs after text deltas have already been emitted,
        // the caller will see duplicate/interrupted output. This is a known
        // limitation — streaming + retry doesn't have clean state recovery.
        return await adapter.chat({ ...params, model: currentModel });
      } catch (error) {
        lastError = error as Error;
        if (!this.isRetryable(error)) break;
        if (attempt < this.policy.maxRetries) {
          const delay = this.policy.retryDelayMs * 2 ** attempt;
          await sleep(delay);
        }
      }
    }

    // Cross-model fallback
    if (
      this.policy.fallbackModel &&
      currentProvider !== this.policy.fallbackModel.provider
    ) {
      const fallback = this.policy.fallbackModel;
      const adapter = this.adapters.get(fallback.provider);
      if (adapter) {
        try {
          return await adapter.chat({ ...params, model: fallback.model });
        } catch (error) {
          lastError = error as Error;
        }
      }
    }

    throw new ModelUnavailableError(
      lastError?.message ?? "Unknown error",
      lastError
    );
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof ModelUnavailableError) return false;

    // Check for HTTP status codes
    const status = (error as { status?: number }).status;
    if (status === 429) return true; // rate limit
    if (status && status >= 500) return true; // server error

    // Check for timeout errors
    const code = (error as { code?: string }).code;
    if (code === "ETIMEDOUT" || code === "ECONNABORTED" || code === "ENOTFOUND") {
      return true;
    }

    // Check error message for retryable patterns
    const msg = String((error as Error).message ?? "").toLowerCase();
    if (msg.includes("rate limit")) return true;
    if (msg.includes("timeout")) return true;
    if (msg.includes("temporarily unavailable")) return true;

    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
