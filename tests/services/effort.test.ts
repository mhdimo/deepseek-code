/**
 * /think is a plain on/off switch. These pin the flip rule its handler leans
 * on: "on" is a reasoning level and "off" is no level, so the level in force
 * *is* the state — there is no second flag that can fall out of sync with it
 * (the old off/whale toggle flipped a StatusBar chip the engine never read).
 */
import { describe, expect, test } from "bun:test";
import { effortToProviderOptions, thinkingToggle } from "../../src/services/effort.js";

describe("thinkingToggle", () => {
  test("flips off when a level is already in force", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(thinkingToggle(level)).toBe("off");
    }
  });

  test("flips on when nothing — or off — is in force", () => {
    expect(thinkingToggle(undefined)).toBe("on");
    expect(thinkingToggle("off")).toBe("on");
  });
});

/**
 * What actually reaches the API. "off" sending nothing is the bug this file
 * exists to prevent from coming back: no reasoning_effort is a request for
 * the provider's default, and the provider's default is thinking on.
 */
describe("effortToProviderOptions", () => {
  test("off asks the provider to disable thinking", () => {
    expect(effortToProviderOptions("off")).toEqual({ openai: { reasoningEffort: "none" } });
  });

  test("an unset level sends nothing at all", () => {
    expect(effortToProviderOptions(undefined)).toBeUndefined();
  });

  test("levels ride through the provider's ladder", () => {
    const wire = (level: "low" | "medium" | "high" | "xhigh" | "max") =>
      (effortToProviderOptions(level) as { openai: { reasoningEffort: string } }).openai
        .reasoningEffort;
    expect(wire("low")).toBe("low");
    expect(wire("high")).toBe("high");
    expect(wire("max")).toBe("max");
    // The two UI tiers the provider folds: medium onto high, xhigh onto high.
    expect(wire("medium")).toBe("high");
    expect(wire("xhigh")).toBe("high");
  });
});
