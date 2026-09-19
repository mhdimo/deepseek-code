import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render } from "ink";
import chalk from "chalk";

import Select, {
  selectLabelWidth,
  selectRowModel,
  type SelectOption,
  type SelectRowInput,
  type SelectRowModel,
} from "../../src/ui/design-system/Select.js";
import { resolveColor, theme } from "../../src/utils/theme.js";

/* The reference's CustomSelect lays a row out as: marker gutter, index cell,
 * label, trailing tick — with the description as a second column on the same
 * line as soon as any visible option carries one. The row builder is what the
 * component renders, so the columns are checked here and the pixels are read
 * back from a real Ink frame below. */

const row = (over: Partial<SelectRowInput> = {}): SelectRowModel =>
  selectRowModel({
    index: 0,
    label: "Option",
    focused: false,
    selected: false,
    indexWidth: 1,
    maxLabelWidth: 0,
    twoColumn: false,
    isFirstVisible: true,
    isLastVisible: true,
    moreAbove: false,
    moreBelow: false,
    ...over,
  });

test("pads the index cell to the widest number, and hides it at width zero", () => {
  expect(row({ index: 0, indexWidth: 2 }).index).toBe("1.  ");
  expect(row({ index: 9, indexWidth: 2 }).index).toBe("10. ");
  expect(row({ index: 0, indexWidth: 1 }).index).toBe("1. ");
  expect(row({ indexWidth: 0 }).index).toBe("");
});

test("draws the focus pointer as a marker and the confirmed tick after the label", () => {
  // Both at once: the reference does not trade one for the other.
  const confirmedAndFocused = row({ selected: true, focused: true });
  expect(confirmedAndFocused.marker).toEqual({ text: "❯ ", color: "suggestion" });
  expect(confirmedAndFocused.tick).toBe(" ✔");
  // U+2714 is figures' tick — not the U+2713 ours used to draw.
  expect(confirmedAndFocused.tick.codePointAt(1)).toBe(0x2714);
  // An unconfirmed row has no tick, however it is focused.
  expect(row({ focused: true }).tick).toBe("");
  expect(row({}).tick).toBe("");
});

test("colours the row by the option's state, selected before focused", () => {
  expect(row({ selected: true, focused: true }).color).toBe("success");
  expect(row({ selected: true }).color).toBe("success");
  expect(row({ focused: true }).color).toBe("suggestion");
  // A disabled row is dimmed but not recoloured — Select renders through
  // `styled={false}`, so ListItem's `disabled → inactive` default never applies.
  expect(row({ disabled: true }).color).toBeUndefined();
  expect(row({}).color).toBeUndefined();
});

test("shows a scroll arrow at the window's edges, down first as the reference does", () => {
  expect(row({ moreAbove: true, isFirstVisible: true }).marker).toEqual({ text: "↑ ", dim: true });
  expect(row({ moreBelow: true, isLastVisible: true }).marker).toEqual({ text: "↓ ", dim: true });
  expect(row({}).marker).toEqual({ text: "  " });
  // A one-row window is both edges; ListItem checks the down arrow first.
  expect(
    row({ moreAbove: true, isFirstVisible: true, moreBelow: true, isLastVisible: true }).marker,
  ).toEqual({ text: "↓ ", dim: true });
});

test("keeps the tick on a disabled row in both branches", () => {
  // ListItem gates the tick on `!disabled`, but Select never sets that prop —
  // `SelectOptionProps` has no `disabled` field — so Select's flat branch
  // shows it, and TwoColumnRow has no gate at all.
  expect(row({ selected: true, disabled: true }).tick).toBe(" ✔");
  expect(row({ selected: true, disabled: true, twoColumn: true }).tick).toBe(" ✔");
});

test("measures the label column as the reference does", () => {
  // marker gutter + index cell + label + the tick's two columns.
  expect(selectLabelWidth({ label: "Third", indexWidth: 1, selected: false })).toBe(2 + 3 + 5);
  expect(selectLabelWidth({ label: "Third", indexWidth: 1, selected: true })).toBe(2 + 3 + 5 + 2);
  expect(selectLabelWidth({ label: "Third", indexWidth: 0, selected: false })).toBe(2 + 5);
  // A ● colour dot takes its own two columns before the label.
  expect(selectLabelWidth({ label: "Third", indexWidth: 1, prefixWidth: 2, selected: false })).toBe(2 + 3 + 2 + 5);
});

test("gives every two-column row a description cell, padded to the widest label", () => {
  const widest = selectLabelWidth({ label: "Very long option name here", indexWidth: 1, selected: true });
  const padded = row({
    label: "Third",
    description: "third one",
    indexWidth: 1,
    twoColumn: true,
    maxLabelWidth: widest,
  });
  expect(padded.description).toBe("third one");
  expect(padded.padding).toBe(" ".repeat(widest - (2 + 3 + 5)));
  // A row with no description still holds the column, so the rest line up.
  expect(row({ twoColumn: true, maxLabelWidth: widest }).description).toBe(" ");
  // Without descriptions there is no description column at all.
  expect(row({ description: "third one", maxLabelWidth: widest }).description).toBeUndefined();
  expect(row({ description: "third one", maxLabelWidth: widest }).padding).toBe("");
});

/* Rendered frames: the builder above is what the component renders, but the
   divergences were in the pixels, so read those back from Ink. */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

/** The frame as Ink wrote it, styles and all. */
async function renderStyledFrame(node: React.ReactElement): Promise<string> {
  let out = "";
  // Ink needs an EventEmitter-shaped stdout and a raw-mode-capable stdin, and
  // only the parts it touches: this process has no TTY.
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 40,
    isTTY: false,
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

  const { unmount, cleanup } = render(node, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  unmount();
  cleanup();
  return out;
}

const renderFrame = async (node: React.ReactElement): Promise<string> =>
  (await renderStyledFrame(node)).replace(ANSI, "");

const rowsOf = (frame: string): string[] => frame.split("\n").filter((line) => line.trim() !== "");

const picker = (options: ReadonlyArray<SelectOption<string>>, extra: Record<string, unknown> = {}) =>
  React.createElement(Select, {
    options,
    defaultValue: options[0]?.value,
    onChange: () => {},
    onCancel: () => {},
    ...extra,
  });

test("renders one row per option, description beside the label", async () => {
  const frame = await renderFrame(
    picker([
      { label: "Default", value: "a", description: "the default one" },
      { label: "Very long option name here", value: "b", description: "another" },
      { label: "Third", value: "c", description: "third one" },
    ]),
  );
  const rows = rowsOf(frame);
  // Three options, three lines: the description shares the label's row, and
  // the label column is padded so every description starts in one column.
  expect(rows).toHaveLength(3);
  expect(rows[0]!.indexOf("the default one")).toBeGreaterThan(0);
  expect(rows[0]!.indexOf("the default one")).toBe(rows[2]!.indexOf("third one"));
  expect(rows[0]).toContain("❯");
  expect(rows[0]).toContain("✔");
});

test("numbers every row by default and keeps the confirmed tick while focused", async () => {
  const frame = await renderFrame(
    picker([
      { label: "Alpha", value: "a" },
      { label: "Beta", value: "b" },
      { label: "Gamma", value: "c" },
    ]),
  );
  // No enableNumberKeys prop: the reference shows the index column unless the
  // caller hides it, and the focused row keeps the tick.
  expect(rowsOf(frame)).toEqual(["❯ 1. Alpha ✔", "  2. Beta", "  3. Gamma"]);
});

test("counts the options the window hides, in a column-three line", async () => {
  const options = Array.from({ length: 9 }, (_, i) => ({ label: `Option ${i + 1}`, value: `v${i}` }));
  const top = rowsOf(await renderFrame(picker(options, { visibleOptionCount: 5 })));
  expect(top.find((line) => line.includes("more…"))).toBe("   and 4 more…");
  // Scrolled to the end the count stands still — it is total minus window,
  // not the rows still below the cursor.
  const bottom = rowsOf(await renderFrame(picker(options, { visibleOptionCount: 5, defaultValue: "v8" })));
  expect(bottom.find((line) => line.includes("more…"))).toBe("   and 4 more…");
});

test("keeps the description column aligned past a ● colour dot", async () => {
  const frame = await renderFrame(
    picker([
      { label: "Alpha", value: "a", description: "first", colorToken: "success" },
      { label: "Beta", value: "b", description: "second", colorToken: "claude" },
    ]),
  );
  // The dot is two columns wide, so the label column is two wider and the
  // description still lands in the same column on both rows.
  expect(rowsOf(frame)).toEqual([
    "❯ 1. ● Alpha ✔  first",
    "  2. ● Beta     second",
  ]);
});

test("paints focus with suggestion, the confirmed row with success, the match bold only", async () => {
  // Ink paints through chalk, whose level this process (no TTY) leaves at 0.
  const level = chalk.level;
  chalk.level = 3;
  try {
    const frame = await renderStyledFrame(
      picker(
        [
          { label: "Alpha", value: "a" },
          { label: "Beta", value: "b" },
        ],
        { highlightText: "et" },
      ),
    );
    const fg = (color: string): string => {
      const [r, g, b] = resolveColor(color).match(/\d+/g)!.map(Number);
      return `\x1b[38;2;${r};${g};${b}m`;
    };
    // The pointer is the suggestion token, not the brand accent.
    expect(frame).toContain(`${fg(theme.suggestion)}❯ `);
    expect(frame).not.toContain(fg(theme.claude));
    // The confirmed row's label and its trailing tick are success green.
    expect(frame).toContain(`${fg(theme.success)}Alpha ✔`);
    // The type-to-filter match is bold in the row's own colour — no brand blue.
    expect(frame).toContain("B\x1b[1met\x1b[22ma");
  } finally {
    chalk.level = level;
  }
});

test("says a plain sentence when there is nothing to choose from", async () => {
  expect((await renderFrame(picker([]))).trim()).toBe("Nothing to choose from.");
  expect((await renderFrame(picker([], { emptyMessage: "No sessions yet." }))).trim()).toBe(
    "No sessions yet.",
  );
});
