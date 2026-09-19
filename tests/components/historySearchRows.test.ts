import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render } from "ink";

import HistorySearch from "../../src/components/HistorySearch.js";

/* Rendered frame. The dialog is a port of Claude Code's HistorySearchDialog:
   FuzzyPicker's ListItem prints the ❯ pointer, then the row's dim 8-column
   relative age, then the prompt's first line, truncated to the row width. The
   pre-port rows printed "▸ " plus the whole (possibly multi-line) entry, with
   no age at all — every assertion here fails against them. */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

async function renderFrame(node: React.ReactElement, columns: number): Promise<string> {
  let out = "";
  // Ink needs an EventEmitter-shaped stdout and a raw-mode-capable stdin, and
  // only the parts it touches: this process has no TTY.
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows: 40,
    isTTY: true,
    write: (chunk: string) => {
      out += chunk;
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as NodeJS.ReadStream;

  // The dialog measures the real terminal; the harness has none.
  const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  try {
    const { unmount, cleanup } = render(node, {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    unmount();
    cleanup();
  } finally {
    if (original) Object.defineProperty(process.stdout, "columns", original);
    else delete (process.stdout as { columns?: number }).columns;
  }
  return out.replace(ANSI, "");
}

const picker = (entries: Array<string | { entry: string; timestamp: number }>): React.ReactElement =>
  React.createElement(HistorySearch, { entries, onPick: () => {}, onClose: () => {} });

test("rows read: pointer, dim 8-column age, then the prompt", async () => {
  const now = Date.now();
  const frame = await renderFrame(
    picker([
      // History is stored oldest-first; the picker walks it newest-first.
      { entry: "older prompt", timestamp: now - 3 * 3600_000 },
      { entry: "newest prompt", timestamp: now - 45_000 },
    ]),
    80,
  );

  // ListItem's pointer (not the "▸" the port used), the age padded to the
  // reference's AGE_WIDTH=8, then the prompt.
  expect(frame).toContain("  ❯ 45s ago  newest prompt");
  expect(frame).toContain("    3h ago   older prompt");
  // Both prompts start in the same column — the point of the padded gutter.
  const promptColumn = (needle: string): number =>
    frame.split("\n").find((line) => line.includes(needle))!.indexOf(needle);
  expect(promptColumn("newest prompt")).toBe(promptColumn("older prompt"));
});

test("multi-line prompts collapse to their first line", async () => {
  const frame = await renderFrame(picker(["first line\nsecond line\nthird line"]), 80);
  // The row itself stays one line tall; only the preview below shows the rest.
  const row = frame.split("\n").find((line) => line.includes("❯"))!;
  expect(row).toContain("first line");
  expect(row).not.toContain("second line");
  expect(row).not.toContain("third line");
});

test("the frame opens with the reference's Search prompts heading", async () => {
  const frame = await renderFrame(picker(["hello"]), 80);
  expect(frame).toContain("Search prompts");
  // The heading sits above the rounded search box, as FuzzyPicker stacks them.
  expect(frame.indexOf("Search prompts")).toBeLessThan(frame.indexOf("╭"));
});

test("empty history reads the reference's copy", async () => {
  const frame = await renderFrame(picker([]), 80);
  // The old empty line ended in a period; upstream's copy has none.
  const emptyLine = frame
    .split("\n")
    .find((line) => line.includes("No history yet"))!;
  expect(emptyLine.trim()).toBe("No history yet");
});

test("the hint line uses upstream's verbs and glyphs", async () => {
  const frame = await renderFrame(picker(["hello"]), 80);
  expect(frame).toContain("↑/↓ to nav · Enter to use · Esc to cancel");
  expect(frame).not.toContain("Enter insert");
});

test("wide terminals spell the hint out and put the preview beside the list", async () => {
  const entries = [{ entry: "a long prompt\nwith more lines", timestamp: Date.now() }];
  const wide = await renderFrame(picker(entries), 120);
  const narrow = await renderFrame(picker(entries), 80);
  expect(wide).toContain("↑/↓ to navigate · Enter to use · Esc to cancel");
  // Wide: the preview box's top border shares the first row's line.
  const wideRow = wide.split("\n").find((line) => line.includes("❯"))!;
  expect(wideRow).toContain("╭");
  // Narrow: it stacks below the list.
  const narrowRow = narrow.split("\n").find((line) => line.includes("❯"))!;
  expect(narrowRow).not.toContain("╭");
  expect(narrow.split("\n").some((line) => line.includes("╭"))).toBe(true);
});

test("the preview box keeps the reference's fixed height", async () => {
  const frame = await renderFrame(picker([{ entry: "one line", timestamp: Date.now() }]), 80);
  const lines = frame.split("\n");
  // The search box is the first framed box; the preview is the last one.
  const top = lines.map((line) => line.includes("╭")).lastIndexOf(true);
  const bottom = lines.map((line) => line.includes("╰")).lastIndexOf(true);
  // PREVIEW_ROWS (6) content rows plus the two border rows, however short the
  // entry is: the dialog never resizes as the selection moves.
  expect(bottom - top + 1).toBe(8);
});
