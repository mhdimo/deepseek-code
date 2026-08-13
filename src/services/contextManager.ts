













import type { TokenBudget, TokenUsage } from "../types/index.js";



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


export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;



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
