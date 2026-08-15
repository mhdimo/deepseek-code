import { describe, expect, test } from "bun:test";
import { previewLine, selectableUserMessages } from "./RewindPicker.js";
import type { Message } from "../types/index.js";

function user(content: string, timestamp?: number): Message {
  return { role: "user", content, timestamp };
}

describe("selectableUserMessages", () => {
  test("filters to non-empty user messages numbered by full-array position", () => {
    const messages: Message[] = [
      { role: "system", content: "boot" },
      user("first prompt"),
      { role: "assistant", content: "a reply" },
      user("   "),
      user("second prompt"),
    ];
    const selected = selectableUserMessages(messages);
    expect(selected.map((s) => s.number)).toEqual([2, 5]);
    expect(selected[0]?.message.content).toBe("first prompt");
    expect(selected[1]?.message.content).toBe("second prompt");
  });

  test("returns an empty list when there is nothing selectable", () => {
    expect(selectableUserMessages([{ role: "system", content: "x" }, user("  ")])).toEqual([]);
  });
});

describe("previewLine", () => {
  test("trims and returns short first lines", () => {
    expect(previewLine(user("  short line\nsecond line\n"))).toBe("short line");
  });

  test("truncates long first lines with an ellipsis", () => {
    expect(previewLine(user("a".repeat(100)), 70)).toBe("a".repeat(69) + "…");
    expect(previewLine(user("a".repeat(10)), 70)).toBe("a".repeat(10));
  });
});
