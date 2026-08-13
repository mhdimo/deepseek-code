





import { createDeepSeek, type Model, type ProviderInstance } from "ai-sdk-cpp";
import type { ProviderConfig, ProviderType } from "../../types/index.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";

export interface ProviderAdapter {
  
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


export function createModel(config: ProviderConfig): Model {
  const adapter = PROVIDER_ADAPTERS[config.type] || PROVIDER_ADAPTERS.deepseek;
  return adapter.createModel(config);
}

export const DEEPSEEK_DEFAULTS = {
  baseURL: DEEPSEEK_BASE_URL,
  model: DEEPSEEK_DEFAULT_MODEL,
} as const;
