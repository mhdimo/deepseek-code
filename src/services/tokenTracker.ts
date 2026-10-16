




import type { TokenUsage, CostEstimate } from "../types/index.js";



interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  
  cacheInputPerMillion: number;
}

/** Peak hours, per million tokens, from DeepSeek's pricing page — off-peak is
 *  exactly half. The table errs high on purpose: an estimate that quietly
 *  undershoots is worse than one that overshoots, and a clock in a status bar
 *  is not worth the peak/off-peak split. */
const FLASH_PRICING: ModelPricing = {
  inputPerMillion: 0.3,
  outputPerMillion: 1.2,
  cacheInputPerMillion: 0.006,
};

const PRO_PRICING: ModelPricing = {
  inputPerMillion: 1.32,
  outputPerMillion: 3.96,
  cacheInputPerMillion: 0.044,
};

const PRICING_TABLE: Record<string, ModelPricing> = {
  "deepseek-flash": FLASH_PRICING,
  "deepseek-v4-pro": PRO_PRICING,
  // Names the API still answers to — requests are served, and billed, as the
  // current models above.
  "deepseek-chat": FLASH_PRICING,
  "deepseek-reasoner": PRO_PRICING,
};


/** A model we do not know (a proxy's own) is priced as the dearest one we do:
 *  an over-estimate is visible and recoverable, an under-estimate is a bill. */
const DEFAULT_PRICING: ModelPricing = PRO_PRICING;

/** The input rate per million tokens — what a caller with only a token count
 *  and no usage breakdown can render, and the one number every cost display
 *  in the app should agree on. */
export function inputRatePerMillion(model: string): number {
  return (PRICING_TABLE[model] ?? DEFAULT_PRICING).inputPerMillion;
}

/** Input and output cost of one call, priced by the model that made it — the
 *  same table the session total comes from, so a turn's cost and the session's
 *  cannot be computed two different ways. */
export function costForTokens(
  model: string,
  promptTokens: number,
  completionTokens: number,
): { inputCost: number; outputCost: number; totalCost: number } {
  const pricing = PRICING_TABLE[model] ?? DEFAULT_PRICING;
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPerMillion;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}



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

  
  setModel(model: string): void {
    this.model = model;
  }

  
  addStepUsage(usage: Partial<TokenUsage>): void {
    this.sessionUsage.promptTokens += usage.promptTokens ?? 0;
    this.sessionUsage.completionTokens += usage.completionTokens ?? 0;
    this.sessionUsage.totalTokens += usage.totalTokens ?? 0;
  }

  
  getSessionUsage(): TokenUsage {
    return { ...this.sessionUsage };
  }

  
  estimateCost(usage?: TokenUsage): CostEstimate {
    const u = usage ?? this.sessionUsage;
    const pricing = PRICING_TABLE[this.model] ?? DEFAULT_PRICING;

    
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

  
  reset(): void {
    this.sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}
