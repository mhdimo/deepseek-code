// Provider registry — returns ai-sdk-cpp (native C++) Model instances.
//
// The engine is now the C++ SDK via the Node binding (was the Vercel AI SDK).
// DeepSeek is OpenAI-compatible, so we use the binding's createDeepSeek, which
// delegates to the C++ OpenAI provider with DeepSeek's base URL + API key.

import { createDeepSeek, type Model, type ProviderInstance } from "ai-sdk-cpp";
import type { ProviderConfig, ProviderType } from "../../types/index.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";

export interface ProviderAdapter {
  /** Build a native (ai-sdk-cpp) Model from a provider config. */
  createModel: (config: ProviderConfig) => Model;
  notes?: string;
}

function createDeepSeekModel(config: ProviderConfig): Model {
  const provider: ProviderInstance = createDeepSeek({
    apiKey: config.apiKey,
    baseUrl: config.baseURL || DEEPSEEK_BASE_URL,
  });
  return provider(config.model || DEEPSEEK_DEFAULT_MODEL);
}

const PROVIDER_ADAPTERS: Record<ProviderType, ProviderAdapter> = {
  deepseek: {
    createModel: createDeepSeekModel,
    notes: "DeepSeek via ai-sdk-cpp (OpenAI-compatible)",
  },
};

export function registerProviderAdapter(type: ProviderType, adapter: ProviderAdapter): void {
  PROVIDER_ADAPTERS[type] = adapter;
}

/** Create a native ai-sdk-cpp Model from a provider config. */
export function createModel(config: ProviderConfig): Model {
  const adapter = PROVIDER_ADAPTERS[config.type] || PROVIDER_ADAPTERS.deepseek;
  return adapter.createModel(config);
}

export const DEEPSEEK_DEFAULTS = {
  baseURL: DEEPSEEK_BASE_URL,
  model: DEEPSEEK_DEFAULT_MODEL,
} as const;
