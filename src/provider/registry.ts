// Provider registry — returns AI SDK LanguageModel instances
//
// "openai" type works for ANY OpenAI-compatible endpoint:
//   OpenAI, GLM, Groq, Together, DeepSeek, Mistral, LM Studio, Ollama, etc.
//   Just set baseURL to the endpoint.

import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderConfig } from "../core/types.js";

/**
 * Create an AI SDK LanguageModel from a provider config.
 */
export function createModel(config: ProviderConfig): LanguageModel {
  switch (config.type) {
    case "anthropic": {
      const provider = createAnthropic({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      });
      return provider(config.model || "claude-sonnet-4-20250514");
    }

    case "openai":
    default: {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      });
      const modelId = config.model || "gpt-4o";
      // Use .chat() to force Chat Completions API (/chat/completions)
      // instead of the Responses API (/responses) which most
      // OpenAI-compatible endpoints (Z.AI, DeepSeek, Groq, etc.) don't support.
      return provider.chat(modelId);
    }
  }
}

/** Model preset with an optional hint for which env var holds the API key */
export interface ModelPreset extends Omit<ProviderConfig, "apiKey"> {
  apiKeyEnv?: string;  // e.g. "OPENAI_API_KEY" — used to auto-resolve the key
}

/** Well-known model presets for quick selection */
export const MODEL_PRESETS: Record<string, ModelPreset> = {
  "gpt-4o":         { type: "openai",    model: "gpt-4o",                                    apiKeyEnv: "OPENAI_API_KEY" },
  "gpt-4.1":        { type: "openai",    model: "gpt-4.1",                                   apiKeyEnv: "OPENAI_API_KEY" },
  "gpt-4.1-mini":   { type: "openai",    model: "gpt-4.1-mini",                              apiKeyEnv: "OPENAI_API_KEY" },
  "o3":             { type: "openai",    model: "o3",                                        apiKeyEnv: "OPENAI_API_KEY" },
  "o4-mini":        { type: "openai",    model: "o4-mini",                                   apiKeyEnv: "OPENAI_API_KEY" },
  "claude-sonnet":  { type: "anthropic", model: "claude-sonnet-4-20250514",                   apiKeyEnv: "ANTHROPIC_API_KEY" },
  "claude-opus":    { type: "anthropic", model: "claude-opus-4-20250514",                     apiKeyEnv: "ANTHROPIC_API_KEY" },
  "claude-haiku":   { type: "anthropic", model: "claude-3-5-haiku-20241022",                  apiKeyEnv: "ANTHROPIC_API_KEY" },
  "deepseek":       { type: "openai",    model: "deepseek-chat",     baseURL: "https://api.deepseek.com/v1",           apiKeyEnv: "DEEPSEEK_API_KEY" },
  "deepseek-r1":    { type: "openai",    model: "deepseek-reasoner", baseURL: "https://api.deepseek.com/v1",           apiKeyEnv: "DEEPSEEK_API_KEY" },
  "glm-4":          { type: "openai",    model: "glm-4",            baseURL: "https://open.bigmodel.cn/api/v1",       apiKeyEnv: "GLM_API_KEY" },
  "groq-llama":     { type: "openai",    model: "llama-3.3-70b-versatile", baseURL: "https://api.groq.com/openai/v1",  apiKeyEnv: "GROQ_API_KEY" },
  "mistral-large":  { type: "openai",    model: "mistral-large-latest",    baseURL: "https://api.mistral.ai/v1",      apiKeyEnv: "MISTRAL_API_KEY" },
  "together-llama": { type: "openai",    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", baseURL: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY" },
};

/**
 * Resolve the API key for a model preset.
 * Priority: ZCODE_API_KEY > preset-specific env var > OPENAI_API_KEY > ANTHROPIC_API_KEY
 */
export function resolvePresetApiKey(preset: ModelPreset, fallbackKey: string): string {
  if (process.env.ZCODE_API_KEY) return process.env.ZCODE_API_KEY;
  if (preset.apiKeyEnv && process.env[preset.apiKeyEnv]) return process.env[preset.apiKeyEnv]!;
  if (fallbackKey) return fallbackKey;
  if (preset.type === "anthropic" && process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  return "";
}

/** Cost per 1M tokens (input/output) — rough estimates */
export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "gpt-4o":                        { input: 2.50,  output: 10.00 },
  "gpt-4.1":                       { input: 2.00,  output: 8.00 },
  "gpt-4.1-mini":                  { input: 0.40,  output: 1.60 },
  "o3":                            { input: 2.00,  output: 8.00 },
  "o4-mini":                       { input: 1.10,  output: 4.40 },
  "claude-sonnet-4-20250514":      { input: 3.00,  output: 15.00 },
  "claude-opus-4-20250514":        { input: 15.00, output: 75.00 },
  "claude-3-5-haiku-20241022":     { input: 0.80,  output: 4.00 },
  "deepseek-chat":                 { input: 0.14,  output: 0.28 },
  "deepseek-reasoner":             { input: 0.55,  output: 2.19 },
};

export function estimateCost(model: string, usage: { promptTokens: number; completionTokens: number }): number {
  const costs = MODEL_COSTS[model];
  if (!costs) return 0;
  return (usage.promptTokens / 1_000_000) * costs.input +
         (usage.completionTokens / 1_000_000) * costs.output;
}
