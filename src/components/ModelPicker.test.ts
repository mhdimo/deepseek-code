import { describe, expect, test } from "bun:test";
import { cycleEffortLevel, defaultEffortForModel } from "./ModelPicker.js";

describe("defaultEffortForModel", () => {
  test("maps the two built-in models", () => {
    expect(defaultEffortForModel("deepseek-chat")).toBe("off");
    expect(defaultEffortForModel("deepseek-reasoner")).toBe("medium");
  });

  test("falls back to off for unknown models", () => {
    expect(defaultEffortForModel("gpt-5")).toBe("off");
  });
});

describe("cycleEffortLevel", () => {
  test("cycles right through the port's ladder", () => {
    expect(cycleEffortLevel("off", "right")).toBe("low");
    expect(cycleEffortLevel("medium", "right")).toBe("high");
    expect(cycleEffortLevel("max", "right")).toBe("off");
  });

  test("cycles left with wrap", () => {
    expect(cycleEffortLevel("off", "left")).toBe("max");
    expect(cycleEffortLevel("low", "left")).toBe("off");
    expect(cycleEffortLevel("high", "left")).toBe("medium");
  });
});
