// Token tracking and cost estimation
//
// Tracks token usage per-request and accumulates session totals.
// Estimates cost based on DeepSeek model pricing.

import type { TokenUsage, CostEstimate } from "../types/index.js";

// ─── DeepSeek pricing per 1M tokens (USD) ──────────────────────────────────

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cache hit discount (DeepSeek offers ~90% off for cached input) */
  cacheInputPerMillion: number;
}

const PRICING_TABLE: Record<string, ModelPricing> = {
  "deepseek-chat": {
    inputPerMillion: 0.27,
    outputPerMillion: 1.10,
    cacheInputPerMillion: 0.07,
  },
  "deepseek-reasoner": {
    inputPerMillion: 0.55,
    outputPerMillion: 2.19,
    cacheInputPerMillion: 0.14,
  },
};

// Fallback for unknown models (conservative)
const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 0.69,
  outputPerMillion: 2.19,
  cacheInputPerMillion: 0.14,
};

// ─── Token formatting helpers ──────────────────────────────────────────────

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(cost: number): string {
  if (cost < 0.0001) return "<$0.001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

// ─── TokenTracker class ────────────────────────────────────────────────────

export class TokenTracker {
  private sessionUsage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  private model: string;

  constructor(model: string) {
    this.model = model;
  }

  /** Update the model name (e.g. after /model switch) */
  setModel(model: string): void {
    this.model = model;
  }

  /** Accumulate token usage from a single step */
  addStepUsage(usage: Partial<TokenUsage>): void {
    this.sessionUsage.promptTokens += usage.promptTokens ?? 0;
    this.sessionUsage.completionTokens += usage.completionTokens ?? 0;
    this.sessionUsage.totalTokens += usage.totalTokens ?? 0;
  }

  /** Get current session totals */
  getSessionUsage(): TokenUsage {
    return { ...this.sessionUsage };
  }

  /** Estimate cost for the current session */
  estimateCost(usage?: TokenUsage): CostEstimate {
    const u = usage ?? this.sessionUsage;
    const pricing = PRICING_TABLE[this.model] ?? DEFAULT_PRICING;

    // Assume 70% of input tokens are cache hits (conservative for multi-turn)
    const cacheHitRate = 0.7;
    const inputCost =
      (u.promptTokens * (1 - cacheHitRate) * pricing.inputPerMillion +
        u.promptTokens * cacheHitRate * pricing.cacheInputPerMillion) /
      1_000_000;
    const outputCost = (u.completionTokens * pricing.outputPerMillion) / 1_000_000;

    return {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
    };
  }

  /** Reset session counters */
  reset(): void {
    this.sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}
