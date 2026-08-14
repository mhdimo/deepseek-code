import { expect, test } from "bun:test";

import {
  commandColumnWidth,
  truncateCommandDescription,
  visibleCommandRange,
} from "../../src/components/commandPickerLayout";

test("uses a bounded width for the command column", () => {
  expect(commandColumnWidth(40)).toBe(16);
  expect(commandColumnWidth(100)).toBe(40);
});

test("truncates descriptions to the available width", () => {
  expect(truncateCommandDescription("a long command description", 10)).toBe("a long co…");
  expect(truncateCommandDescription("short", 10)).toBe("short");
});

test("keeps the selected command inside a small visible range", () => {
  expect(visibleCommandRange(20, 10)).toEqual({ start: 7, end: 13 });
  expect(visibleCommandRange(20, 1)).toEqual({ start: 0, end: 6 });
  expect(visibleCommandRange(3, 1)).toEqual({ start: 0, end: 3 });
});
