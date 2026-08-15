import { describe, expect, test } from "bun:test";
import {
  AGENT_COLORS,
  agentColorToThemeToken,
  isAgentColor,
} from "./agentColorManager.js";

describe("agentColorManager", () => {
  test("all eight palette colors are valid", () => {
    expect(AGENT_COLORS).toHaveLength(8);
    for (const color of AGENT_COLORS) {
      expect(isAgentColor(color)).toBe(true);
      expect(agentColorToThemeToken(color)).toMatch(/_FOR_SUBAGENTS_ONLY$/);
    }
  });

  test("invalid and missing colors map to undefined", () => {
    expect(isAgentColor("magenta")).toBe(false);
    expect(agentColorToThemeToken("magenta")).toBeUndefined();
    expect(agentColorToThemeToken(undefined)).toBeUndefined();
    expect(agentColorToThemeToken("")).toBeUndefined();
  });

  test("each color maps to a distinct theme token", () => {
    const tokens = AGENT_COLORS.map((c) => agentColorToThemeToken(c));
    expect(new Set(tokens).size).toBe(AGENT_COLORS.length);
  });
});
