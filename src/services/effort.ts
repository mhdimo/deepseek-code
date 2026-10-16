





















import type { EffortLevel } from "../state/storage.js";
import { loadSettings } from "../state/storage.js";
import { loadConfig } from "../utils/config.js";

const EFFORT_LEVELS: readonly EffortLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];


export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Which way a bare /thinking flips: off when thinking is on, on when it is not.
 *  "On" is a reasoning level and "off" is no level — that level is the whole
 *  state, so there is no second flag that can fall out of sync with it. */
export function thinkingToggle(level: EffortLevel | undefined): "on" | "off" {
  return level !== undefined && level !== "off" ? "off" : "on";
}


/**
 * Folds the UI's tiers onto the provider's ladder. "xhigh" has no
 * provider-side equivalent, and "medium" folds up to "high" the way the
 * provider maps it too — so the value that actually reaches the model is
 * decided here, once, rather than left to a mapping table elsewhere.
 * "off" never reaches this function; it has its own value (see
 * effortToProviderOptions).
 */
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
 * The provider options for a level — or undefined when no level is in force.
 *
 * "off" is a level, not an absence: it sends `reasoningEffort: "none"`, the
 * value the API documents for turning thinking off. It used to return
 * undefined like the unset case did, and that is why /thinking off changed
 * nothing: sending *no* reasoning_effort is not "off", it is "your default,
 * please", and the default for these models is thinking on. The only state
 * that still sends nothing is a genuinely unset level ("auto"), where leaving
 * the choice to the provider is the point.
 */
export function effortToProviderOptions(
  effort: EffortLevel | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!effort) return undefined;
  if (effort === "off") return { openai: { reasoningEffort: "none" } };
  return { openai: { reasoningEffort: mapEffortToProvider(effort) } };
}


export function getEffortLevel(): EffortLevel | undefined {
  const merged = loadConfig();
  if (isEffortLevel(merged.effort)) return merged.effort;
  
  
  const persisted = loadSettings().effort;
  return isEffortLevel(persisted) ? persisted : undefined;
}
