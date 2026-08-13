





















import type { EffortLevel } from "../state/storage.js";
import { loadSettings } from "../state/storage.js";
import { loadConfig } from "../utils/config.js";

const EFFORT_LEVELS: readonly EffortLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];


export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}


export function mapEffortToProvider(effort: EffortLevel): EffortLevel {
  switch (effort) {
    case "medium":
    case "xhigh":
      return "high";
    default:
      return effort;
  }
}


export function effortToProviderOptions(
  effort: EffortLevel | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!effort || effort === "off") return undefined;
  return { openai: { reasoningEffort: mapEffortToProvider(effort) } };
}


export function getEffortLevel(): EffortLevel | undefined {
  const merged = loadConfig();
  if (isEffortLevel(merged.effort)) return merged.effort;
  
  
  const persisted = loadSettings().effort;
  return isEffortLevel(persisted) ? persisted : undefined;
}
