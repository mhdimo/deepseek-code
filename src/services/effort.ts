// Reasoning-effort plumbing.
//
// Maps the user-facing EffortLevel ("off" | "low" | "medium" | "high" |
// "xhigh" | "max") to Agent providerOptions for the OpenAI-compatible
// provider used by DeepSeek. The C++ binding reads
// providerOptions.openai.reasoningEffort and sends `reasoning_effort` to the
// API.
//
// Provider mapping (the API exposes fewer levels than the UI offers):
//
//   requested  →  sent
//   low           low
//   medium        high
//   high          high
//   xhigh         high
//   max           max
//
// Resolution order for the active level (see src/utils/config.ts):
//   CLI args > persisted settings > env vars > config file > defaults
// i.e. the merged loadConfig() value wins; otherwise the raw persisted
// setting; otherwise unset ("off" → provider default, unchanged behavior).

import type { EffortLevel } from "../state/storage.js";
import { loadSettings } from "../state/storage.js";
import { loadConfig } from "../utils/config.js";

const EFFORT_LEVELS: readonly EffortLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

/** Runtime guard — config file / CLI values arrive untyped via JSON. */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** The level actually sent to the provider for a requested level. */
export function mapEffortToProvider(effort: EffortLevel): EffortLevel {
  switch (effort) {
    case "medium":
    case "xhigh":
      return "high";
    default:
      return effort;
  }
}

/**
 * Map an effort level to Agent providerOptions for the OpenAI-compatible
 * provider. Returns undefined when unset or "off" — the Agent is built exactly
 * as before, so behavior is unchanged unless the user opts in.
 */
export function effortToProviderOptions(
  effort: EffortLevel | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!effort || effort === "off") return undefined;
  return { openai: { reasoningEffort: mapEffortToProvider(effort) } };
}

/**
 * Resolve the active effort level: merged config (CLI > persisted > env > file)
 * wins over the raw persisted setting; unset/invalid → undefined ("off").
 */
export function getEffortLevel(): EffortLevel | undefined {
  const merged = loadConfig();
  if (isEffortLevel(merged.effort)) return merged.effort;
  // loadConfig() already merges persisted settings, so this is a defensive
  // fallback only — kept to make the precedence explicit.
  const persisted = loadSettings().effort;
  return isEffortLevel(persisted) ? persisted : undefined;
}
