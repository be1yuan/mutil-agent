import type { ModelProvider, Usage } from "../types/core.js";

// ── Pricing table ──

const PRICING: Record<ModelProvider, { input: number; output: number; cacheHit?: number }> = {
  deepseek: { input: 2.87, output: 5.74, cacheHit: 0.0238 }, // 1 USD = 7 CNY
  zhipu: { input: 7.0, output: 22.4 }, // 1 USD = 7 CNY
  mimo: { input: 7.0, output: 21.0, cacheHit: 1.4 }, // 1 USD = 7 CNY
  kimi: { input: 8.0, output: 24.0 }, // approximate pricing, subject to provider billing
  qwen: { input: 4.0, output: 12.0 }, // approximate pricing, subject to provider billing
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
   * @returns Estimated worst-case cost in yuan (RMB)
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
