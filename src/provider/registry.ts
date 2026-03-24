// Provider registry — returns AI SDK LanguageModel instances
//
// DeepSeek uses an OpenAI-compatible API endpoint.
// API docs: https://api-docs.deepseek.com/

import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderConfig, ProviderType } from "../core/types.js";

// ─── DeepSeek API Configuration ─────────────────────────────────────────────

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";

// ─── Provider adapters ──────────────────────────────────────────────────────

export interface ProviderAdapter {
  /** Build an AI SDK LanguageModel from a provider config */
  createModel: (config: ProviderConfig) => LanguageModel;
  /** Human-readable note shown in docs/help if needed */
  notes?: string;
}

/**
 * DeepSeek adapter using OpenAI-compatible API.
 * DeepSeek's API follows the OpenAI Chat Completions format.
 * Models: deepseek-chat, deepseek-reasoner
 */
function createDeepSeekModel(config: ProviderConfig): LanguageModel {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL || DEEPSEEK_BASE_URL,
  });

  const modelId = config.model || DEEPSEEK_DEFAULT_MODEL;
  // Use .chat() to force Chat Completions API (/chat/completions)
  return provider.chat(modelId);
}

const PROVIDER_ADAPTERS: Record<ProviderType, ProviderAdapter> = {
  deepseek: {
    createModel: createDeepSeekModel,
    notes: "DeepSeek API — models: deepseek-chat, deepseek-reasoner",
  },
};

/**
 * Runtime extension point for custom adapters.
 */
export function registerProviderAdapter(type: ProviderType, adapter: ProviderAdapter): void {
  PROVIDER_ADAPTERS[type] = adapter;
}

/**
 * Create an AI SDK LanguageModel from a provider config.
 */
export function createModel(config: ProviderConfig): LanguageModel {
  const adapter = PROVIDER_ADAPTERS[config.type] || PROVIDER_ADAPTERS.deepseek;
  return adapter.createModel(config);
}

// Export defaults for convenience
export const DEEPSEEK_DEFAULTS = {
  baseURL: DEEPSEEK_BASE_URL,
  model: DEEPSEEK_DEFAULT_MODEL,
} as const;
