import type { Theme } from "../../utils/theme.js";
import type { AgentColorName } from "../../types/index.js";

/**
 * Agent color palette — Claude Code agentColorManager parity. Each color
 * maps to a dedicated theme token so teammates stay visually distinct in
 * the fanout, task list, and status pill.
 */

export const AGENT_COLORS: readonly AgentColorName[] = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const;

export const AGENT_COLOR_TO_THEME_COLOR = {
  red: "red_FOR_SUBAGENTS_ONLY",
  blue: "blue_FOR_SUBAGENTS_ONLY",
  green: "green_FOR_SUBAGENTS_ONLY",
  yellow: "yellow_FOR_SUBAGENTS_ONLY",
  purple: "purple_FOR_SUBAGENTS_ONLY",
  orange: "orange_FOR_SUBAGENTS_ONLY",
  pink: "pink_FOR_SUBAGENTS_ONLY",
  cyan: "cyan_FOR_SUBAGENTS_ONLY",
} as const satisfies Record<AgentColorName, keyof Theme>;

export function isAgentColor(value: string): value is AgentColorName {
  return (AGENT_COLORS as readonly string[]).includes(value);
}

/** Resolve a color name to its theme token (undefined when unset/invalid). */
export function agentColorToThemeToken(color: string | undefined): keyof Theme | undefined {
  if (!color || !isAgentColor(color)) return undefined;
  return AGENT_COLOR_TO_THEME_COLOR[color];
}
