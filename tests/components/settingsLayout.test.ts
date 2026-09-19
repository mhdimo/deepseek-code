import { expect, test } from "bun:test";

import {
  buildSettingsLines,
  formatSettingValue,
  settingMatches,
  settingsMaxVisible,
  settingsWindow,
  SETTINGS_LABEL_WIDTH,
} from "../../src/components/settingsLayout";
import type { Setting } from "../../src/components/settingsRows";

test("reserves the panel's chrome out of the pinned pane height", () => {
  // The Settings shell pins every tab to this height; the list has to fit
  // inside it rather than pushing the tab row around.
  expect(settingsMaxVisible(30, 24)).toBe(20);
  expect(settingsMaxVisible(15, 24)).toBe(5);
  // Standalone (no pinned height): 80% of the terminal, capped at 30.
  expect(settingsMaxVisible(undefined, 24)).toBe(9);
  expect(settingsMaxVisible(undefined, 8)).toBe(5);
  expect(settingsMaxVisible(undefined, 200)).toBe(20);
});

test("keeps the cursor inside the window and reports what is left out", () => {
  expect(settingsWindow(16, 0, 5, 0)).toEqual({ start: 0, end: 5, above: 0, below: 11 });
  expect(settingsWindow(16, 6, 5, 0)).toEqual({ start: 2, end: 7, above: 2, below: 9 });
  // Sticky: a move that stays inside the window does not scroll it.
  expect(settingsWindow(16, 3, 5, 2).start).toBe(2);
  // A move past the top edge drags the window with it.
  expect(settingsWindow(16, 1, 5, 3).start).toBe(1);
  // Nothing to scroll, and nothing to say about it.
  expect(settingsWindow(3, 1, 5, 0)).toEqual({ start: 0, end: 3, above: 0, below: 0 });
  expect(settingsWindow(0, 0, 5, 0)).toEqual({ start: 0, end: 0, above: 0, below: 0 });
  // A stale offset (list shrank under it) is clamped, never trusted.
  expect(settingsWindow(6, 5, 5, 99).start).toBe(1);
});

test("never scrolls the selected row out of the window", () => {
  for (let selected = 0; selected < 16; selected++) {
    for (const offset of [0, 3, 11, 99]) {
      const w = settingsWindow(16, selected, 5, offset);
      expect(selected).toBeGreaterThanOrEqual(w.start);
      expect(selected).toBeLessThan(w.end);
    }
  }
});

const rows: Setting[] = [
  { id: "a", label: "Model", description: "which model", type: "text", value: "deepseek-chat", editSeed: "", onChange: () => {} },
  { id: "b", label: "Effort", description: "how hard", type: "enum", value: "high", options: ["off", "high"], onChange: () => {} },
  { id: "c", label: "Co-Authored-By", description: "trailer", type: "boolean", value: false, onChange: () => {} },
];

test("renders the window with the markers the panel shows", () => {
  const lines = buildSettingsLines(rows, {
    selectedIndex: 2,
    maxVisible: 2,
    offset: 0,
    showSelection: true,
  });
  expect(lines).toEqual([
    { kind: "more", direction: "above", count: 1 },
    { kind: "row", id: "b", label: "Effort", value: "high", selected: false },
    { kind: "row", id: "c", label: "Co-Authored-By", value: "false", selected: true },
  ]);
});

test("says so when nothing matches instead of rendering an empty list", () => {
  expect(buildSettingsLines([], { selectedIndex: 0, maxVisible: 5, offset: 0, showSelection: true }))
    .toEqual([{ kind: "empty" }]);
});

test("drops the highlight while searching or editing", () => {
  const lines = buildSettingsLines(rows, {
    selectedIndex: 1,
    maxVisible: 5,
    offset: 0,
    showSelection: false,
  });
  expect(lines.some((l) => l.kind === "row" && l.selected)).toBe(false);
});

test("formats the value column", () => {
  expect(formatSettingValue(rows[0]!)).toBe("deepseek-chat");
  expect(formatSettingValue(rows[2]!)).toBe("false");
  expect(
    formatSettingValue({
      id: "themeMode",
      label: "Theme",
      description: "why",
      type: "enum",
      value: "auto",
      options: ["auto"],
      display: (v) => `Auto (${v})`,
      onChange: () => {},
    }),
  ).toBe("Auto (auto)");
});

test("search matches the id, the label and the description", () => {
  expect(settingMatches(rows[1]!, "effort")).toBe(true);
  expect(settingMatches(rows[1]!, "how hard")).toBe(true);
  expect(settingMatches(rows[1]!, "")).toBe(true);
  expect(settingMatches(rows[1]!, "  ")).toBe(true);
  expect(settingMatches(rows[1]!, "model")).toBe(false);
});

test("leaves the value column a readable width", () => {
  expect(SETTINGS_LABEL_WIDTH).toBe(44);
  for (const row of rows) {
    expect(row.label.length).toBeLessThan(SETTINGS_LABEL_WIDTH);
  }
});
