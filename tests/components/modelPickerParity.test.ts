/**
 * /model against Claude Code's ModelPicker.
 *
 * Four things a user reads on this screen, all of them diverging before the
 * fix: the dim sentence under the bold "Select model" heading (the reference
 * explains what the switch applies to; the port printed "Current: <provider>/
 * <model>"), the input guide (the reference's standalone picker closes with
 * "Enter to confirm · Esc to exit"; the port listed four hints and lower-cased
 * the key names), the effort level (the reference prints it through lodash
 * `capitalize` — "◐ Medium effort"; the port printed the raw lower-case level)
 * and the window size (the reference shows up to ten rows; the port stopped at
 * seven and pushed the rest into the "and N more…" count).
 */
import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";

import ModelPicker, { type ModelPickerProfile } from "../../src/components/ModelPicker.js";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

function frame(props: Record<string, unknown> = {}, columns = 140): string {
  return renderToString(
    React.createElement(ModelPicker, {
      currentModel: "deepseek-chat",
      currentProvider: "deepseek",
      onSelect: () => {},
      onCancel: () => {},
      ...props,
    }),
    { columns },
  ).replace(ANSI, "");
}

/** The same frame with runs of whitespace collapsed, so an assertion about a
 *  sentence is not defeated by ink wrapping it. */
const flat = (out: string): string => out.replace(/\s+/g, " ");

/** `count` configured profiles, so the list is longer than one window. */
function profiles(count: number): Record<string, ModelPickerProfile> {
  const out: Record<string, ModelPickerProfile> = {};
  for (let i = 1; i <= count; i++) {
    out[`profile${String(i).padStart(2, "0")}`] = { provider: "openrouter", model: `model-${i}` };
  }
  return out;
}

test("the heading carries the reference's explanatory line, not the active model", () => {
  const out = flat(frame());

  expect(out).toContain(
    "Switch between DeepSeek models. Applies to this session and future DeepSeek Code sessions. For other/previous model names, specify with --model.",
  );
  expect(out).not.toContain("Current: deepseek/deepseek-chat");
});

test("the picker foots with the reference's two-hint guide", () => {
  const out = frame();

  expect(out).toContain("Enter to confirm · Esc to exit");
  // The port's four-hint line, with its lower-case key names.
  expect(out).not.toContain("↑↓ to choose");
  expect(out).not.toContain("← → effort");
  expect(out).not.toContain("esc to cancel");
});

test("the effort level is capitalised", () => {
  const out = frame({ currentEffort: "medium" });

  expect(out).toContain("◐ Medium effort");
  expect(out).not.toContain("medium effort");
});

test("ten rows are visible before the list scrolls", () => {
  const out = frame({ profiles: profiles(12) });

  // Two built-ins then twelve profiles; the tenth option is profile08, which
  // a seven-row window would have hidden behind "and 7 more…".
  expect(out).toContain("profile08");
  expect(out).toContain("and 4 more…");
  expect(out).not.toContain("and 7 more…");
});
