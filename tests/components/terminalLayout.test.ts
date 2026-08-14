import { expect, test } from "bun:test";

import {
  INK_RENDER_OPTIONS,
  safeTerminalRows,
  separatorWidth,
  transcriptContainerHeight,
} from "../../src/components/terminalLayout";

test("uses full redraws for Ink input stability", () => {
  expect(INK_RENDER_OPTIONS.incrementalRendering).toBe(false);
});

test("uses a usable terminal row fallback", () => {
  expect(safeTerminalRows(undefined)).toBe(40);
  expect(safeTerminalRows(0)).toBe(40);
  expect(safeTerminalRows(24)).toBe(24);
});

test("keeps separators at least one column wide", () => {
  expect(separatorWidth(0)).toBe(1);
  expect(separatorWidth(80)).toBe(80);
});

test("lets the transcript shrink around the prompt", () => {
  expect(transcriptContainerHeight(40, 6)).toBe(34);
  expect(transcriptContainerHeight(4, 6)).toBe(0);
});
