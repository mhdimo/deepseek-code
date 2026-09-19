/**
 * The theme picker's demo block, as it reaches the screen.
 *
 * The picker shows the selected theme over a sample diff, and the preview is
 * the whole point of the screen — so the frame around that diff, the status
 * line under it and the key hints at the bottom are the parts a user reads.
 * Claude Code's ThemePicker draws the frame with its dashed border style (a
 * `╌` rule above and below, no side rails), prints a syntax-highlighting
 * status line under it and, when the picker is opened on its own, closes with
 * an italic "Enter to select · Esc to cancel" line. Ours drew the rules by
 * hand with `┄`, showed no status line and had no closing hint.
 *
 * The status line is the one place the port must NOT copy the reference
 * verbatim: the reference's text reports a `syntaxHighlightingDisabled`
 * setting, a syntax theme and a `ctrl+t` binding, none of which this app has,
 * so porting the string would advertise a shortcut that does nothing. The
 * assertion below pins the property that matters — the line exists, and it
 * names no key.
 */
import { expect, test } from "bun:test";
import React from "react";
import { Box, renderToString } from "ink";

import ThemePicker from "../../src/components/ThemePicker.js";

/** U+00B7 MIDDLE DOT, the separator the reference's Byline joins hints with. */
const MIDDOT = "·";

/** The picker sizes its demo diff from the terminal; pin both sides to the
 *  same width so the frame assertions are about layout, not about whether the
 *  test happens to run under a TTY. */
const terminalColumns = (): number => process.stdout.columns || 80;

function frame(props: Record<string, unknown> = {}, columns = terminalColumns()): string {
  return renderToString(
    React.createElement(ThemePicker, {
      onThemeSelect: () => {},
      onCancel: () => {},
      ...props,
    }),
    { columns },
  );
}

const lines = (out: string): string[] => out.split("\n");

/** Rows that are nothing but one repeated glyph — the frame's rules. */
const rulesOf = (out: string, glyph: string): string[] =>
  lines(out).filter((line) => line.length > 0 && line.split("").every((ch) => ch === glyph));

test("the demo diff is framed with dashed rules, not hand-drawn runs", () => {
  const out = frame();

  const rules = rulesOf(out, "╌"); // ╌ BOX DRAWINGS LIGHT DOUBLE DASH HORIZONTAL
  expect(rules.length).toBe(2);
  // The reference passes the terminal width to StructuredDiff and lets the
  // border box stretch with it; a rule shorter than the terminal means the
  // box is sizing itself to the diff text instead.
  expect(rules[0]!.length).toBe(terminalColumns());
  expect(rules[1]!.length).toBe(terminalColumns());

  // The old hand-drawn rules were `┄` runs one row outside the diff.
  expect(out).not.toContain("┄"); // ┄ BOX DRAWINGS LIGHT TRIPLE DASH HORIZONTAL
});

test("the syntax status line sits under the demo diff and names no shortcut", () => {
  const out = frame();

  const status = " Syntax highlighting is not available for diffs";
  const statusAt = out.indexOf(status);
  expect(statusAt).toBeGreaterThan(-1);
  // Under the diff, and below the closing rule.
  expect(statusAt).toBeGreaterThan(out.indexOf("Hello, DeepSeek!"));
  expect(statusAt).toBeGreaterThan(out.indexOf("╌", out.indexOf("Hello, DeepSeek!")));
  // Exactly one such line.
  expect(lines(out).filter((line) => line.includes("Syntax highlighting")).length).toBe(1);

  // No dead shortcut: this build has no syntax-highlighting toggle at all.
  expect(out).not.toContain("ctrl+t");
});

test("the standalone picker closes with the Enter/Esc hint line", () => {
  const out = frame();
  expect(out).toContain(`Enter to select ${MIDDOT} Esc to cancel`);

  // It is the last thing on screen, one blank row below the content.
  const all = lines(out);
  const at = all.indexOf(`Enter to select ${MIDDOT} Esc to cancel`);
  expect(at).toBe(all.length - 1);
  expect(all[at - 1]).toBe("");
});

test("onboarding keeps the closing hint out of its frame", () => {
  const out = frame({ showIntroText: true });
  expect(out).toContain("Let's get started.");
  expect(out).not.toContain("Enter to select");
});

test("the onboarding preview fits the margin the stepper gives it", () => {
  // Onboarding renders this picker inside a <Box marginX={1}>. A preview sized
  // to the terminal rather than to that box overflows by two columns, and ink
  // wraps every row — the wrapped remainder becomes a blank row *and* the
  // row's +/- sigil is lost, so the sample stops looking like a diff.
  const columns = terminalColumns();
  const out = renderToString(
    React.createElement(
      Box,
      { marginX: 1 },
      React.createElement(ThemePicker, {
        onThemeSelect: () => {},
        onCancel: () => {},
        showIntroText: true,
      }),
    ),
    { columns },
  );

  const all = lines(out);
  const rules = all
    .map((line, i) => [line.trim(), i] as const)
    .filter(([line]) => line.length > 0 && line.split("").every((ch) => ch === "╌"));
  expect(rules.length).toBe(2);

  const preview = all.slice(rules[0]![1] + 1, rules[1]![1]);
  expect(preview.length).toBe(4);
  expect(preview.map((line) => line.trim().length === 0)).toEqual([false, false, false, false]);
  expect(preview[1]).toContain("-  console.log");
  expect(preview[2]).toContain("+  console.log");
});

test("all seven themes are listed at once, not windowed to the shared default", () => {
  const out = frame();
  const all = lines(out);

  // The reference passes `visibleOptionCount={themeOptions.length}`, so the
  // picker is as tall as the list. The shared Select default (5) would hide
  // the last two behind an overflow row — a regression a user would see as
  // "the ANSI themes are gone".
  for (const label of [
    "Auto (match terminal)",
    "Dark mode",
    "Light mode",
    "Dark mode (colorblind-friendly)",
    "Light mode (colorblind-friendly)",
    "Dark mode (ANSI colors only)",
    "Light mode (ANSI colors only)",
  ]) {
    expect(all.some((line) => line.includes(label))).toBe(true);
  }
  expect(out).not.toContain("more…");
});
