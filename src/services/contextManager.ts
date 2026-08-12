// Context manager — token tracking, usage estimation, and compaction signaling
//
// Responsibilities:
//   - Track actual token usage (from C++ session finish events)
//   - Detect when approaching context limits and signal for compaction
//   - Expose usage ratio for the UI context bar
//
// DeepSeek v4 has a 1M context window. All budgets default to that.
//
// NOTE: the C++ Session owns compaction itself (the TS side must NOT compact);
// this module only tracks usage and surfaces warnings. Message-shaping helpers
// (compact/truncate/prepareForAPI) from the pre-C++ era were removed — the
// binding manages the message window.

import type { TokenBudget, TokenUsage } from "../types/index.js";

// ─── Default budgets per model ──────────────────────────────────────────────

export const DEFAULT_BUDGETS: Record<string, TokenBudget> = {
  "deepseek-chat": {
    maxContextTokens: 1_000_000,
    compactionThreshold: 0.8,
    reservedForResponse: 8192,
  },
  "deepseek-reasoner": {
    maxContextTokens: 1_000_000,
    compactionThreshold: 0.8,
    reservedForResponse: 16384,
  },
};

const FALLBACK_BUDGET: TokenBudget = {
  maxContextTokens: 1_000_000,
  compactionThreshold: 0.8,
  reservedForResponse: 8192,
};

// Threshold for auto-compact warning (claude-code compatible)
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

// ─── ContextManager class ───────────────────────────────────────────────────

export class ContextManager {
  private budget: TokenBudget;
  private model: string;

  /** Cumulative token usage tracked from C++ session finish events */
  private cumulativeUsage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  /** Whether we've already warned about approaching the context limit */
  private compactionWarningIssued = false;

  constructor(model: string, budget?: TokenBudget) {
    this.model = model;
    this.budget = budget ?? DEFAULT_BUDGETS[model] ?? FALLBACK_BUDGET;
  }

  /** Update model (e.g. after /model switch) */
  setModel(model: string): void {
    this.model = model;
    this.budget = DEFAULT_BUDGETS[model] ?? FALLBACK_BUDGET;
  }

  /** Get the current budget */
  getBudget(): TokenBudget {
    return this.budget;
  }

  /** Get the effective context window (max - reserved for output) */
  getEffectiveLimit(): number {
    return this.budget.maxContextTokens - this.budget.reservedForResponse;
  }

  /** Get the auto-compact threshold (effective limit minus buffer) */
  getAutoCompactThreshold(): number {
    return this.getEffectiveLimit() - AUTOCOMPACT_BUFFER_TOKENS;
  }

  /**
   * Track token usage reported from a C++ session finish event.
   * The C++ session reports cumulative (session-wide) usage, so we use
   * the latest reported value directly.
   */
  trackUsage(usage: Partial<TokenUsage>): void {
    if (usage.totalTokens !== undefined) {
      this.cumulativeUsage.totalTokens = usage.totalTokens;
    }
    if (usage.promptTokens !== undefined) {
      this.cumulativeUsage.promptTokens = usage.promptTokens;
    }
    if (usage.completionTokens !== undefined) {
      this.cumulativeUsage.completionTokens = usage.completionTokens;
    }
  }

  /** Get the current cumulative usage from C++ reports */
  getUsage(): TokenUsage {
    return { ...this.cumulativeUsage };
  }

  /** Get the context usage percentage (0-100) based on cumulative C++ reported tokens */
  getUsagePercent(): number {
    const limit = this.getEffectiveLimit();
    if (limit <= 0) return 0;
    return Math.min(100, Math.round((this.cumulativeUsage.totalTokens / limit) * 100));
  }

  /** Check if we should warn about approaching context limit */
  shouldWarn(): boolean {
    if (this.compactionWarningIssued) return false;
    const threshold = this.getAutoCompactThreshold();
    this.compactionWarningIssued = this.cumulativeUsage.totalTokens >= threshold;
    return this.compactionWarningIssued;
  }

  /** Reset cumulative usage (call on /clear or /compact) */
  reset(): void {
    this.cumulativeUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.compactionWarningIssued = false;
  }
}
