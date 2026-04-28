import type { ModelProvider, Usage } from "../types/core.js";

// ── Pricing table ──

const PRICING: Record<ModelProvider, { input: number; output: number; cacheHit?: number }> = {
  deepseek: { input: 0.41, output: 0.82, cacheHit: 0.0034 },
  zhipu: { input: 1.0, output: 3.2 },
  mimo: { input: 1.0, output: 3.0, cacheHit: 0.2 },
};

// ── Cost tracker ──

export class CostTracker {
  private _spent = 0;

  constructor(private budget: number) {}

  get spent(): number {
    return this._spent;
  }

  get remaining(): number {
    return this.budget - this._spent;
  }

  get budgetAmount(): number {
    return this.budget;
  }

  /** Record cost after each model call */
  record(usage: Usage, provider: ModelProvider): void {
    const pricing = PRICING[provider];
    const cost =
      (usage.inputTokens / 1_000_000) * pricing.input +
      (usage.outputTokens / 1_000_000) * pricing.output +
      (usage.cacheReadTokens / 1_000_000) * (pricing.cacheHit ?? 0);
    this._spent += cost;
  }

  /** Check if we can afford an estimated cost */
  canAfford(estimatedCost: number): boolean {
    return this._spent + estimatedCost <= this.budget;
  }

  /**
   * Estimate the worst-case cost for a single model call.
   * Uses max_tokens as the upper bound for output, plus a rough
   * estimate of input tokens from the message history.
   *
   * @param provider - The model provider
   * @param inputTokenEstimate - Estimated input tokens for this call
   * @param maxTokens - The max_tokens parameter (output token cap)
   * @returns Estimated worst-case cost in dollars
   */
  estimateWorstCase(
    provider: ModelProvider,
    inputTokenEstimate: number,
    maxTokens: number
  ): number {
    const pricing = PRICING[provider];
    if (!pricing) return 0;
    const inputCost = (inputTokenEstimate / 1_000_000) * pricing.input;
    const outputCost = (maxTokens / 1_000_000) * pricing.output;
    return inputCost + outputCost;
  }

  /** Check if we've crossed the 80% warning threshold */
  isOverWarningThreshold(): boolean {
    return this._spent > this.budget * 0.8;
  }
}
