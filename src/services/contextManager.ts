













import type { TokenBudget, TokenUsage } from "../types/index.js";



/**
 * Model context windows, in tokens.
 *
 * The engine sizes its sliding-window strategy from the `maxContextTokens` the
 * caller passes and falls back to 128K when there is none
 * (`ai_session_create_with_memory` in bindings/c/ai_sdk.cpp), so TS and C++ have
 * to name the same window: two different numbers means the status bar describes
 * a session that does not exist, and the engine compacts on a schedule nobody
 * was told about.
 *
 * That agreement is why this table has been wrong in both directions. It first
 * said 1M for everything, which was a guess; for the V3-era models the service
 * actually served 128K, and the effect was *no compaction at all* — the engine
 * evicts turns only once the history passes
 * `maxContextTokens - reserved_output_tokens`, so a 1M window put the trigger
 * past the provider's real limit and a long session grew until the API refused
 * it. It was then corrected to 128K, which is right for those models and wrong
 * for the V4 family that replaced them.
 *
 * V4 serves 1M. The API's own error names the output ceiling as `[1, 393216]`
 * — 384K, the V4 figure — for every model it answers to, including the
 * `deepseek-chat`/`deepseek-reasoner` aliases, which now route to it. So the
 * aliases are listed at 1M as well: an alias is not a window, it is a name for
 * whatever is behind it, and what is behind them today is a million tokens.
 *
 * A model that is not listed gets DEFAULT_CONTEXT_WINDOW below. That stays
 * conservative on purpose — an unknown model that is really large compacts
 * earlier than it has to, which is recoverable, while an unknown model that is
 * really small overflows mid-task with no warning, which is not. A proxy
 * serving more can say so with DEEPSEEK_CONTEXT_WINDOW.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // V4.
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-flash": 1_000_000,
  // Names the API still answers to, resolving to the V4 family.
  "deepseek-chat": 1_000_000,
  "deepseek-reasoner": 1_000_000,
};

export const DEFAULT_CONTEXT_WINDOW = 128 * 1024;

/** Mirrors the engine's `ContextWindow::reserved_output_tokens`. */
export const RESERVED_OUTPUT_TOKENS = 4096;

/**
 * How long before the engine's trigger the warning fires. The engine evicts
 * turns as soon as the history passes `maxContextTokens - reservedForResponse`;
 * this margin is the notice the user gets, and the chance to compact
 * deliberately instead of having it happen to them.
 */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/** The context window for `model`, overridable for a proxy that serves more. */
export function contextWindowFor(model: string): number {
  const override = Number(process.env.DEEPSEEK_CONTEXT_WINDOW);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

function budgetFor(model: string): TokenBudget {
  const window = contextWindowFor(model);
  return {
    maxContextTokens: window,
    // The fraction at which the warning fires, derived rather than declared so
    // the two cannot drift apart.
    compactionThreshold: (window - RESERVED_OUTPUT_TOKENS - AUTOCOMPACT_BUFFER_TOKENS) / window,
    reservedForResponse: RESERVED_OUTPUT_TOKENS,
  };
}

export const DEFAULT_BUDGETS: Record<string, TokenBudget> = Object.fromEntries(
  Object.keys(MODEL_CONTEXT_WINDOWS).map((model) => [model, budgetFor(model)]),
);

const FALLBACK_BUDGET: TokenBudget = budgetFor("");



export class ContextManager {
  private budget: TokenBudget;
  private model: string;

  
  private cumulativeUsage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  
  private compactionWarningIssued = false;

  constructor(model: string, budget?: TokenBudget) {
    this.model = model;
    this.budget = budget ?? DEFAULT_BUDGETS[model] ?? FALLBACK_BUDGET;
  }

  
  setModel(model: string): void {
    this.model = model;
    this.budget = DEFAULT_BUDGETS[model] ?? FALLBACK_BUDGET;
  }

  
  getBudget(): TokenBudget {
    return this.budget;
  }

  
  getEffectiveLimit(): number {
    return this.budget.maxContextTokens - this.budget.reservedForResponse;
  }

  
  getAutoCompactThreshold(): number {
    return this.getEffectiveLimit() - AUTOCOMPACT_BUFFER_TOKENS;
  }

  
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

  
  getUsage(): TokenUsage {
    return { ...this.cumulativeUsage };
  }

  
  getUsagePercent(): number {
    const limit = this.getEffectiveLimit();
    if (limit <= 0) return 0;
    return Math.min(100, Math.round((this.cumulativeUsage.totalTokens / limit) * 100));
  }

  
  shouldWarn(): boolean {
    if (this.compactionWarningIssued) return false;
    const threshold = this.getAutoCompactThreshold();
    this.compactionWarningIssued = this.cumulativeUsage.totalTokens >= threshold;
    return this.compactionWarningIssued;
  }

  
  reset(): void {
    this.cumulativeUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.compactionWarningIssued = false;
  }
}
