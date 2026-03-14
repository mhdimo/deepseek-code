// Provider registry — returns AI SDK LanguageModel instances
//
// "openai" type works for ANY OpenAI-compatible endpoint:
//   OpenAI, GLM, Groq, Together, DeepSeek, Mistral, LM Studio, Ollama, etc.
//   Just set baseURL to the endpoint.

import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderConfig, ProviderType } from "../core/types.js";

// ─── Provider adapters ──────────────────────────────────────────────────────

export interface ProviderAdapter {
  /** Build an AI SDK LanguageModel from a provider config */
  createModel: (config: ProviderConfig) => LanguageModel;
  /** Human-readable note shown in docs/help if needed */
  notes?: string;
}

/**
 * OpenAI-compatible adapter.
 * Works with providers implementing Chat Completions semantics.
 */
function createOpenAICompatibleModel(config: ProviderConfig): LanguageModel {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });

  const modelId = config.model || "gpt-4o";
  // Use .chat() to force Chat Completions API (/chat/completions)
  // instead of the Responses API (/responses) which many
  // OpenAI-compatible endpoints don't support.
  return provider.chat(modelId);
}

function createAnthropicModel(config: ProviderConfig): LanguageModel {
  const provider = createAnthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });
  return provider(config.model || "claude-sonnet-4-20250514");
}

const PROVIDER_ADAPTERS: Record<ProviderType, ProviderAdapter> = {
  openai: {
    createModel: createOpenAICompatibleModel,
    notes: "Any OpenAI-compatible API endpoint (OpenAI, GLM/Z.AI, DeepSeek, Groq, Together, etc.)",
  },
  anthropic: {
    createModel: createAnthropicModel,
  },
};

/**
 * Runtime extension point for custom adapters.
 * (Useful for forks that add provider types.)
 */
export function registerProviderAdapter(type: ProviderType, adapter: ProviderAdapter): void {
  PROVIDER_ADAPTERS[type] = adapter;
}

/**
 * Create an AI SDK LanguageModel from a provider config.
 */
export function createModel(config: ProviderConfig): LanguageModel {
  const adapter = PROVIDER_ADAPTERS[config.type] || PROVIDER_ADAPTERS.openai;
  return adapter.createModel(config);
}
