import { expect, test } from "bun:test";

import {
  ageCell,
  emptyMessage,
  footerHint,
  formatAge,
  historyRow,
  previewWidthFor,
  rowWidthFor,
  truncateToWidth,
} from "../../src/components/HistorySearch.js";

/* The dialog's row/column arithmetic, pinned to Claude Code's
   HistorySearchDialog (AGE_WIDTH=8, PREVIEW_ROWS=6, rowWidth derived from the
   list column) and FuzzyPicker's hint line. */

test("age cell pads to eight columns and reads upstream's units", () => {
  const now = 1_700_000_000_000;
  expect(formatAge(now - 1_000, now)).toBe("1s ago");
  expect(formatAge(now - 45_000, now)).toBe("45s ago");
  expect(formatAge(now - 5 * 60_000, now)).toBe("5m ago");
  expect(formatAge(now - 3 * 3600_000, now)).toBe("3h ago");
  expect(formatAge(now - 2 * 86_400_000, now)).toBe("2d ago");
  expect(formatAge(now, now)).toBe("0s ago");
  // Upstream right-pads the age to AGE_WIDTH so every prompt starts alike.
  expect(ageCell(now - 3 * 3600_000, now)).toBe("3h ago  ");
  expect(ageCell(now - 45_000, now)).toBe("45s ago ");
  expect(ageCell(now - 2 * 86_400_000, now)).toBe("2d ago  ");
  expect(ageCell(now - 2 * 86_400_000, now)).toHaveLength(8);
});

test("an entry without a timestamp still gets the gutter", () => {
  // history.json carries no timestamps yet, so the column must keep its width
  // and the prompt text must stay in one column (see the report's storage/App
  // patch, which threads real timestamps through).
  expect(ageCell(undefined, Date.now())).toBe("        ");
  const row = historyRow("legacy entry", { rowWidth: 40 });
  expect(row.age).toHaveLength(8);
  expect(row.text).toBe("legacy entry");
});

test("long first lines are truncated to the row width with an ellipsis", () => {
  const truncated = truncateToWidth("x".repeat(200), 30);
  expect(truncated).toHaveLength(30);
  expect(truncated.endsWith("…")).toBe(true);
  expect(truncateToWidth("short", 30)).toBe("short");
  // The reference reserves the pointer's gap and AGE_WIDTH out of the list.
  expect(rowWidthFor(80, false)).toBe(80 - 6 - 8 - 1);
  // A right-hand preview halves the list, and the preview takes the rest.
  expect(rowWidthFor(120, true)).toBe(Math.floor((120 - 6) * 0.5) - 8 - 1);
  expect(previewWidthFor(120, true)).toBe(120 - Math.floor((120 - 6) * 0.5) - 12);
  expect(previewWidthFor(80, false)).toBe(80 - 10);
});

test("empty-state copy is the reference's", () => {
  expect(emptyMessage("")).toBe("No history yet");
  expect(emptyMessage("zzz")).toBe("No matching prompts");
});

test("the hint line uses upstream's verbs and glyphs", () => {
  expect(footerHint(80)).toBe("↑/↓ to nav · Enter to use · Esc to cancel");
  expect(footerHint(119)).toBe("↑/↓ to nav · Enter to use · Esc to cancel");
  expect(footerHint(120)).toBe("↑/↓ to navigate · Enter to use · Esc to cancel");
});
