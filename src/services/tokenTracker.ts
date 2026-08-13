




import type { TokenUsage, CostEstimate } from "../types/index.js";



interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  
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


const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 0.69,
  outputPerMillion: 2.19,
  cacheInputPerMillion: 0.14,
};



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
