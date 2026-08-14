













import type { DeepSeekCodeConfig, ProviderConfig } from "../types/index.js";



export type ErrorClass = "overload" | "prompt-too-long" | null;

const OVERLOAD_RE = /429|overload/i;
const PROMPT_TOO_LONG_RE = /413|prompt is too long|maximum context length/i;


export function classifyError(errorText: string): ErrorClass {
  const text = String(errorText ?? "");
  if (OVERLOAD_RE.test(text)) return "overload";
  if (PROMPT_TOO_LONG_RE.test(text)) return "prompt-too-long";
  return null;
}




export function promptTooLongMessage(): string {
  return (
    "Warning: prompt is too long for the model's context window.\n\n" +
    "  /compact   — summarize the conversation to free context\n" +
    "  /clear     — start a fresh conversation\n\n" +
    "(Compaction is handled by the session engine; use the commands above.)"
  );
}


export function overloadMessage(model: string): string {
  return (
    "Warning: the provider is overloaded or rate-limited (HTTP 429) and no fallback " +
    "model is configured.\n\n" +
    "  - Wait a moment and resend the prompt\n" +
    "  - Configure a fallback: set the DEEPSEEK_FALLBACK_MODEL env var or add " +
    "a second profile to .deepseek-code.json\n" +
    `  - Switch models with /model${model ? ` (current: ${model})` : ""}`
  );
}




export function resolveFallbackProvider(
  config: DeepSeekCodeConfig,
  current: ProviderConfig,
): ProviderConfig | null {
  const envModel = process.env.DEEPSEEK_FALLBACK_MODEL;
  if (envModel && envModel.trim()) {
    return {
      type: current.type,
      model: envModel.trim(),
      apiKey: current.apiKey,
      baseURL: current.baseURL,
    };
  }

  const profiles = config.profiles ?? {};
  for (const [, profile] of Object.entries(profiles)) {
    if (
      profile.provider === current.type &&
      profile.model === current.model &&
      (profile.baseURL || undefined) === (current.baseURL || undefined)
    ) {
      continue; 
    }
    return {
      type: profile.provider,
      model: profile.model,
      apiKey: profile.apiKey || current.apiKey,
      baseURL: profile.baseURL || current.baseURL,
    };
  }

  return null;
}
