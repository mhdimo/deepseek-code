// recovery.ts — engine error classification + fallback resolution
//
// App.tsx wires this into the streaming 'error' event:
//
//   prompt-too-long → a system message telling the user to /compact or /clear.
//     The C++ session owns compaction; the TS side must NOT compact.
//
//   overload → one-shot retry of the same prompt against a fallback
//     provider/model (first OTHER configured profile, or the
//     DEEPSEEK_FALLBACK_MODEL env var). Never retries more than once per
//     user turn — the guard lives in App.tsx (recoveryAttemptedRef).
//
// Pure TS, no React/Ink/Bun dependencies — unit-testable in isolation.

import type { DeepSeekCodeConfig, ProviderConfig } from "../types/index.js";

// ─── Classification ─────────────────────────────────────────────────────────

export type ErrorClass = "overload" | "prompt-too-long" | null;

const OVERLOAD_RE = /429|overload/i;
const PROMPT_TOO_LONG_RE = /413|prompt is too long|maximum context length/i;

/**
 * Classify an error string into the recoverable failure families.
 * Anything unrecognized returns null (the caller shows the raw error).
 */
export function classifyError(errorText: string): ErrorClass {
  const text = String(errorText ?? "");
  if (OVERLOAD_RE.test(text)) return "overload";
  if (PROMPT_TOO_LONG_RE.test(text)) return "prompt-too-long";
  return null;
}

// ─── User-facing messages ────────────────────────────────────────────────────

/** Shown when the prompt exceeds the model's context window. */
export function promptTooLongMessage(): string {
  return (
    "⚠ Prompt is too long for the model's context window.\n\n" +
    "  /compact   — summarize the conversation to free context\n" +
    "  /clear     — start a fresh conversation\n\n" +
    "(Compaction is handled by the session engine; use the commands above.)"
  );
}

/** Shown when the provider is overloaded and no fallback can be used. */
export function overloadMessage(model: string): string {
  return (
    "⚠ The provider is overloaded or rate-limited (HTTP 429) and no fallback " +
    "model is configured.\n\n" +
    "  • Wait a moment and resend the prompt\n" +
    "  • Configure a fallback: set the DEEPSEEK_FALLBACK_MODEL env var or add " +
    "a second profile to .deepseek-code.json\n" +
    `  • Switch models with /model${model ? ` (current: ${model})` : ""}`
  );
}

// ─── Fallback resolution ─────────────────────────────────────────────────────

/**
 * Resolve a fallback provider configuration for overload recovery, or null
 * when none exists.
 *
 * Priority:
 *   1. DEEPSEEK_FALLBACK_MODEL env var — same provider/endpoint, new model.
 *   2. The first configured profile (config.profiles) that differs from the
 *      active provider+model ("first OTHER profile"). Profiles live in
 *      .deepseek-code.json under "profiles"; each is a ModelProfile with its
 *      own provider/model/apiKey/baseURL.
 *
 * Returns null when neither exists (App then surfaces overloadMessage()).
 */
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
      continue; // identical to the active config — not a fallback
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
