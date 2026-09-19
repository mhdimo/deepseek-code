import { expect, test } from "bun:test";
import React from "react";
import chalk from "chalk";
import { renderToString, Text } from "ink";
import stringWidth from "string-width";
import type { StructuredPatchHunk } from "diff";

import {
  buildDiffModel,
  DiffFrame,
  StructuredDiff,
  StructuredDiffList,
  type DiffRowModel,
} from "../../src/components/StructuredDiff.js";
import {
  buildToolBlockSpans,
  TOOL_OUT_LEFT,
  type ToolBlockSpan,
} from "../../src/components/ToolBlock.js";
import { ThemeProvider } from "../../src/ui/design-system/ThemeProvider.js";
import { getTheme, resolveColor } from "../../src/utils/theme.js";
import type { ToolUseBlock } from "../../src/types/index.js";

/** r,g,b of an "rgb(r,g,b)" or "#rrggbb" colour (the two forms the theme
 *  uses); mirrors what chalk turns either into. */
const rgbTriplet = (color: string): [number, number, number] => {
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (hex) {
    return [
      Number.parseInt(hex[1]!, 16),
      Number.parseInt(hex[2]!, 16),
      Number.parseInt(hex[3]!, 16),
    ];
  }
  throw new Error(`not an rgb()/hex colour: ${color}`);
};

const ESC = String.fromCharCode(27);

/** The foreground escape chalk emits for a theme colour. */
const fgEscape = (color: string): string => {
  const [r, g, b] = rgbTriplet(color);
  return `${ESC}[38;2;${r};${g};${b}m`;
};

/** The background escape chalk emits for a theme colour. */
const bgEscape = (color: string): string => {
  const [r, g, b] = rgbTriplet(color);
  return `${ESC}[48;2;${r};${g};${b}m`;
};

const dark = getTheme("dark");
const light = getTheme("light");

const CONTENT_WIDTH = 96;

const toolBlock = (toolName: string, output: string): ToolUseBlock =>
  ({
    toolName,
    status: "done",
    argsJson: JSON.stringify({ file_path: "src/foo.ts" }),
    input: { file_path: "src/foo.ts" },
    output,
    isExpanded: true,
  }) as unknown as ToolUseBlock;

const editOutput = (hunks: string): string =>
  ["Edited src/foo.ts", "", "Diff preview:", hunks].join("\n");

const writeOutput = (lines: string[]): string =>
  ["Wrote src/bar.ts (3 lines)", "", "Added lines:", ...lines].join("\n");

const diffSpans = (spans: ToolBlockSpan[]): ToolBlockSpan[] =>
  spans.filter((s) => s.diff !== undefined);

const rowsOf = (span: ToolBlockSpan): DiffRowModel[] => span.diff!;

/** The code on a row, without the band's trailing fill (marked copySkip). */
const runText = (row: DiffRowModel): string =>
  row.runs.filter((r) => !r.style?.copySkip).map((r) => r.text).join("");

const runsWidth = (row: DiffRowModel): number =>
  row.runs.reduce((sum, r) => sum + r.text.length, 0);

const spanText = (span: ToolBlockSpan): string =>
  span.rows.map((r) => r.runs.map((x) => x.text).join("")).join("\n");

// The body of an Edit/Write result is the reference's
// FileEditToolUpdatedMessage: stats line, then the hunks. The file is named
// on the tool-use row above (● Edit(src/foo.ts)), so the body must not
// repeat it — the reference has no such row.
test("edit result body is the stats line followed by the diff rows", () => {
  const spans = buildToolBlockSpans(
    toolBlock(
      "Edit",
      editOutput("@@ -1,4 +1,5 @@\n const a = 1;\n-const b = oldValue;\n+const b = newValue;\n"),
    ),
    CONTENT_WIDTH,
    false,
    dark,
  );

  expect(spans[0]!.key).toBe("stats");
  expect(spanText(spans[0]!)).toBe("Added 1 line, removed 1 line");
  // Counts are the only bold runs, as in the reference.
  expect(spans[0]!.rows[0]!.runs.filter((r) => r.style?.bold).map((r) => r.text)).toEqual(["1", "1"]);
});

test("stats wording follows the reference: Removed is capitalised only without additions", () => {
  const onlyRemoved = buildToolBlockSpans(
    toolBlock("Edit", editOutput("@@ -1,2 +1,1 @@\n-const a = 1;\n")),
    CONTENT_WIDTH,
    false,
    dark,
  );
  expect(spanText(onlyRemoved[0]!)).toBe("Removed 1 line");

  const onlyAdded = buildToolBlockSpans(
    toolBlock("Edit", editOutput("@@ -1,1 +1,2 @@\n+const a = 1;\n")),
    CONTENT_WIDTH,
    false,
    dark,
  );
  expect(spanText(onlyAdded[0]!)).toBe("Added 1 line");
});

// Line numbers come from the hunk's oldStart and are captured before the
// counter moves, so an added line shows the number of the line it replaced
// (same as the reference's numberDiffLines). The sigil is the last column.
test("diff rows carry line-number gutter + sigil, one row per source line", () => {
  const spans = buildToolBlockSpans(
    toolBlock(
      "Edit",
      editOutput(
        "@@ -1,4 +1,5 @@\n const a = 1;\n const b = 2;\n-const c = oldValue;\n+const c = newValue;\n const d = 4;\n",
      ),
    ),
    CONTENT_WIDTH,
    false,
    dark,
  );

  const rows = rowsOf(diffSpans(spans)[0]!);
  expect(rows.map((r) => r.gutter)).toEqual([" 1  ", " 2  ", " 3 -", " 3 +", " 4  "]);
  expect(rows.map((r) => r.type)).toEqual(["nochange", "nochange", "remove", "add", "nochange"]);
  expect(rows.map(runText)).toEqual([
    "const a = 1;",
    "const b = 2;",
    "const c = oldValue;",
    "const c = newValue;",
    "const d = 4;",
  ]);
});

// The reference's fallback renderer writes `color={overrideTheme ? 'text'
// : undefined}` on the gutter, and `overrideTheme` is always set — it is the
// current theme name, read with useTheme() inside StructuredDiffFallback and
// handed to formatDiff. Its ThemedText then resolves dimColor to `inactive`
// and an explicit colour to `text`, so the gutter is the text token (or
// inactive where the gutter is dimmed), never a diff-direction colour: the
// reference theme has no such token at all.
test("gutter takes the theme text token, inactive on unchanged rows", () => {
  const spans = buildToolBlockSpans(
    toolBlock(
      "Edit",
      editOutput("@@ -1,2 +1,3 @@\n const a = 1;\n-const b = oldValue;\n+const b = newValue;\n"),
    ),
    CONTENT_WIDTH,
    false,
    dark,
  );

  const rows = rowsOf(diffSpans(spans)[0]!);
  // Unchanged row: dimColor={dim || type === 'nochange'} -> theme.inactive.
  expect(rows[0]!.gutterColor).toBe(resolveColor(dark.inactive));
  // Changed rows: dimColor={dim} with dim false -> theme.text.
  expect(rows[1]!.gutterColor).toBe(resolveColor(dark.text));
  expect(rows[2]!.gutterColor).toBe(resolveColor(dark.text));
});

// Nothing in a diff row is painted with the port's old direction-coloured
// gutter tokens; they have no counterpart in the reference theme.
test("no diff row uses a diff-direction gutter colour", () => {
  const spans = buildToolBlockSpans(
    toolBlock(
      "Edit",
      editOutput("@@ -1,2 +1,3 @@\n const a = 1;\n-const b = oldValue;\n+const b = newValue;\n"),
    ),
    CONTENT_WIDTH,
    false,
    dark,
  );

  const rows = rowsOf(diffSpans(spans)[0]!);
  const colours = rows.flatMap((r) => [r.gutterColor, ...r.runs.map((x) => x.style?.color)]);
  expect(colours).not.toContain(resolveColor(dark.diffAddedGutter));
  expect(colours).not.toContain(resolveColor(dark.diffRemovedGutter));
});

// Changed rows set an explicit foreground: theme.text is the one token that
// stays legible on the dark bands and on the pale light-theme bands alike.
test("changed rows use the theme text colour on the line background", () => {
  const spans = buildToolBlockSpans(
    toolBlock(
      "Edit",
      editOutput("@@ -1,2 +1,3 @@\n const a = 1;\n-const b = oldValue;\n+const b = newValue;\n"),
    ),
    CONTENT_WIDTH,
    false,
    light,
  );

  const rows = rowsOf(diffSpans(spans)[0]!);
  const added = rows[2]!;
  const removed = rows[1]!;
  expect(added.runs.every((r) => r.style?.color === resolveColor(light.text))).toBe(true);
  expect(removed.runs.every((r) => r.style?.color === resolveColor(light.text))).toBe(true);
  expect(added.runs[0]!.style?.backgroundColor).toBe(resolveColor(light.diffAdded));
  expect(removed.runs[0]!.style?.backgroundColor).toBe(resolveColor(light.diffRemoved));
});

// Unchanged rows take the text token as well: the reference's content Text is
// the same `color={overrideTheme ? 'text' : undefined}` for every line type,
// and only the gutter is dimmed on a nochange row.
test("unchanged rows take the theme text token, not the terminal default", () => {
  const spans = buildToolBlockSpans(
    toolBlock(
      "Edit",
      editOutput("@@ -1,2 +1,3 @@\n const a = 1;\n-const b = oldValue;\n+const b = newValue;\n"),
    ),
    CONTENT_WIDTH,
    false,
    dark,
  );

  const rows = rowsOf(diffSpans(spans)[0]!);
  expect(rows[0]!.type).toBe("nochange");
  expect(rows[0]!.runs.every((r) => r.style?.color === resolveColor(dark.text))).toBe(true);
});

// The reference resolves dimColor to the theme's inactive colour in ThemedText
// and never forwards it to ink, so a dimmed diff row is a colour rather than
// an ANSI faint attribute (our `dim` run flag becomes chalk.dim).
test("dimmed rows use theme.inactive rather than an ANSI faint", () => {
  const rows = buildDiffModel(["-old value", "+new value", " context"], 1, 60, true, dark);

  expect(rows.map((r) => r.type)).toEqual(["remove", "add", "nochange"]);
  for (const row of rows) {
    expect(row.runs.every((r) => r.style?.color === resolveColor(dark.inactive))).toBe(true);
    expect(row.runs.some((r) => r.style?.dim)).toBe(false);
  }
  expect(rows[0]!.runs[0]!.style?.backgroundColor).toBe(resolveColor(dark.diffRemovedDimmed));
  expect(rows[1]!.runs[0]!.style?.backgroundColor).toBe(resolveColor(dark.diffAddedDimmed));
  expect(rows[2]!.runs[0]!.style?.backgroundColor).toBeUndefined();
});

// A removed/added pair whose parts pack to nothing — two blank lines — draws
// no row at all in the reference: formatDiff falls back to standard rendering
// only when generateWordDiffElements returns null, and an empty pack returns
// an empty array.
test("a blank-line pair draws no row instead of falling back", () => {
  expect(buildDiffModel(["-", "+"], 1, 60, false, dark)).toEqual([]);
});

// An added (or removed) blank line has no content to show, but the reference
// still paints its whole row with the band: the padding is part of the same
// Text as the line. The port's copy-skipped fill has to be visible there or
// RowText collapses the row to nothing and the band breaks.
test("an added blank line still draws its full-width band", () => {
  const rows = buildDiffModel(["+", " const a = 1;"], 1, 40, false, dark);
  expect(rows.map((r) => r.gutter)).toEqual([" 1 +", " 2  "]);
  expect(rows[0]!.runs.some((r) => r.style?.copySkip)).toBe(false);
  expect(runsWidth(rows[0]!)).toBe(40 - 4);

  const previousLevel = chalk.level;
  chalk.level = 3;
  try {
    const patch: StructuredPatchHunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      lines: ["+", " const a = 1;"],
    };
    const out = String(
      renderToString(React.createElement(StructuredDiff, { patch, width: 40 }), { columns: 40 }),
    );
    expect(out).toContain(bgEscape(resolveColor(dark.diffAdded)!));
  } finally {
    chalk.level = previousLevel;
  }
});

// A light terminal gets the reference's light bands and decorations. The
// dark-theme values are near-black bands with a green number that a pale
// background swallows whole — nothing like the reference on a light theme.
test("light theme carries the reference's light diff bands", () => {
  expect(light.diffAdded).toBe("rgb(105,219,124)");
  expect(light.diffRemoved).toBe("rgb(255,168,180)");
  expect(light.diffAddedWord).toBe("rgb(47,157,68)");
  expect(light.diffRemovedWord).toBe("rgb(209,69,75)");
  expect(light.diffAddedGutter).toBe("rgb(36,138,61)");
  expect(light.diffRemovedGutter).toBe("rgb(207,34,46)");
});

// Past the 40% change ratio the word highlight is dropped and the whole
// line renders as one band — the reference does this in BOTH renderers
// (CHANGE_THRESHOLD / wordDiffStrings).
test("a rewritten line pair renders as full-line bands, not word highlights", () => {
  const spans = buildToolBlockSpans(
    toolBlock(
      "Edit",
      editOutput("@@ -1,1 +1,2 @@\n-const b = oldValue;\n+const b = newValue;\n"),
    ),
    CONTENT_WIDTH,
    false,
    dark,
  );

  const rows = rowsOf(diffSpans(spans)[0]!);
  const backgrounds = rows.flatMap((r) => r.runs.map((x) => x.style?.backgroundColor));
  expect(backgrounds).not.toContain(resolveColor(dark.diffRemovedWord));
  expect(backgrounds).not.toContain(resolveColor(dark.diffAddedWord));
  expect(rows[0]!.runs[0]!.style?.backgroundColor).toBe(resolveColor(dark.diffRemoved));
  expect(rows[1]!.runs[0]!.style?.backgroundColor).toBe(resolveColor(dark.diffAdded));
});

// Under the threshold the changed words keep their stronger background.
test("a small change keeps word-level highlighting", () => {
  const spans = buildToolBlockSpans(
    toolBlock(
      "Edit",
      editOutput(
        "@@ -1,1 +1,2 @@\n-const value = compute(a, b);\n+const value = compute(a, c);\n",
      ),
    ),
    CONTENT_WIDTH,
    false,
    dark,
  );

  const rows = rowsOf(diffSpans(spans)[0]!);
  const removedWord = rows[0]!.runs.find(
    (r) => r.style?.backgroundColor === resolveColor(dark.diffRemovedWord),
  );
  const addedWord = rows[1]!.runs.find(
    (r) => r.style?.backgroundColor === resolveColor(dark.diffAddedWord),
  );
  expect(removedWord?.text).toBe("b");
  expect(addedWord?.text).toBe("c");

  // Only the changed words carry the word colour; the unchanged parts keep
  // the line band and the row's text token. A remove row shows removed plus
  // unchanged parts and skips the added ones, and vice versa for an add row.
  expect(rows[0]!.runs.some((r) => r.style?.backgroundColor === resolveColor(dark.diffRemoved))).toBe(true);
  expect(rows[0]!.runs.some((r) => r.style?.backgroundColor === resolveColor(dark.diffAddedWord))).toBe(false);
  expect(runText(rows[0]!)).toBe("const value = compute(a, b);");
  expect(runText(rows[1]!)).toBe("const value = compute(a, c);");
  expect(rows[0]!.runs.every((r) => r.style?.color === resolveColor(dark.text))).toBe(true);
  // The band is continuous: 4 columns of gutter (number, space, sigil) beside
  // the rest of the row, for a block indented by the result prefix. Deriving
  // the second term from TOOL_OUT_LEFT rather than writing 5 keeps this test
  // honest if MessageResponse's "  ⎿  " prefix ever changes width.
  expect(stringWidth(rows[0]!.gutter)).toBe(4);
  expect(runsWidth(rows[0]!)).toBe(CONTENT_WIDTH - TOOL_OUT_LEFT - 4);
});

// Wrapped rows keep the sigil column: a continuation is still part of the
// same added line (the reference's native renderer re-marks every physical
// row of a line, the ink one pads the number column and prints the sigil).
test("wrapped continuation rows keep the sigil", () => {
  const long = "x".repeat(120);
  const rows = buildDiffModel([`+${long}`], 1, 40, false, dark);

  expect(rows.length).toBeGreaterThan(1);
  expect(rows[0]!.gutter).toBe(" 1 +");
  for (const row of rows.slice(1)) {
    expect(row.gutter).toBe("   +");
    expect(row.type).toBe("add");
  }
});

// Every row is padded to the band width so the background runs to the edge
// of the block, and the padding is excluded from a copy (copySkip).
test("rows pad to the content width with copy-skipped fill", () => {
  const spans = buildToolBlockSpans(
    toolBlock(
      "Edit",
      editOutput("@@ -1,2 +1,3 @@\n const a = 1;\n-const b = oldValue;\n+const b = newValue;\n"),
    ),
    CONTENT_WIDTH,
    false,
    dark,
  );

  const span = diffSpans(spans)[0]!;
  for (const row of rowsOf(span)) {
    expect(runsWidth(row)).toBe(span.width);
    const fill = row.runs[row.runs.length - 1]!;
    expect(fill.style?.copySkip).toBe(true);
  }
});

// Hunks are separated by a dim "..." row, the reference's omitted-context
// marker between two remote parts of the same file.
test("remote hunks are separated by a dim ellipsis row", () => {
  const spans = buildToolBlockSpans(
    toolBlock(
      "Edit",
      editOutput(
        "@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n const c = 3;\n@@ -40,2 +41,2 @@\n-const x = 1;\n+const x = 9;\n const z = 3;\n",
      ),
    ),
    CONTENT_WIDTH,
    false,
    dark,
  );

  expect(spans.map((s) => s.key)).toEqual(["stats", "diff-0", "sep-1", "diff-1"]);
  expect(spanText(spans[2]!)).toBe("...");
  expect(spans[2]!.rows[0]!.runs.every((r) => r.style?.dim)).toBe(true);

  // Each hunk is numbered from its own oldStart, and the number column is
  // as wide as that hunk's largest number.
  const rows = rowsOf(spans[3]!);
  expect(rows.map((r) => r.gutter)).toEqual([" 40 -", " 40 +", " 41  "]);
});

// A brand-new file has no @@ hunks; the tool hands us "+"-prefixed lines, so
// the block renders them as an all-additions diff.
test("a created file renders as an all-additions diff", () => {
  const spans = buildToolBlockSpans(
    toolBlock("Write", writeOutput(["+export const x = 1;", "+export const y = 2;", "+export const z = 3;"])),
    CONTENT_WIDTH,
    false,
    dark,
  );

  expect(spans[0]!.key).toBe("stats");
  expect(spanText(spans[0]!)).toBe("Added 3 lines");
  const rows = rowsOf(diffSpans(spans)[0]!);
  expect(rows.map((r) => r.gutter)).toEqual([" 1 +", " 2 +", " 3 +"]);
  expect(rows.map(runText)).toEqual(["export const x = 1;", "export const y = 2;", "export const z = 3;"]);
});

// Claude Code's DiffFrame always draws its dashed frame: the loading
// placeholder is a child of the bordered box, not a replacement for it. Our
// port used to return the bare "…" and drop the frame.
test("the diff frame is drawn around its placeholder too", () => {
  const frame = String(
    renderToString(React.createElement(DiffFrame, { placeholder: true }), { columns: 24 }),
  );
  expect(frame).toContain("╌");
  expect(frame).toContain("…");
});

// The border is the theme's subtle token (the reference passes
// borderColor="subtle"), so it moves with the theme instead of a fixed ANSI
// "gray" that the port used. Colours only reach the output when chalk has a
// colour level, which a non-TTY test process does not set by default.
test("the diff frame border follows the theme's subtle token", () => {
  const previousLevel = chalk.level;
  chalk.level = 3;
  try {
    const renderFrame = (setting: "dark" | "light"): string =>
      String(
        renderToString(
          React.createElement(ThemeProvider, {
            initialState: setting,
            children: React.createElement(DiffFrame, null, React.createElement(Text, null, "x")),
          }),
          { columns: 24 },
        ),
      );

    const darkFrame = renderFrame("dark");
    const lightFrame = renderFrame("light");
    expect(darkFrame).toContain(fgEscape(resolveColor(getTheme("dark").subtle)!) + "╌");
    expect(lightFrame).toContain(fgEscape(resolveColor(getTheme("light").subtle)!) + "╌");
    // And not a plain ANSI gray, which is what the unfixed code emitted.
    expect(darkFrame).not.toContain(`${String.fromCharCode(27)}[90m`);
  } finally {
    chalk.level = previousLevel;
  }
});

// Every hunk line is drawn, and the only ink the list adds of its own is the
// dim "..." gap *between* hunks. The port once carried a `maxRows` cap for
// this; Claude Code has no such bound, so a diff that overflowed lost its tail
// silently — the approval dialog showed a file body that stopped mid-file with
// nothing to say it had.
test("every hunk line is drawn, with no truncation and no marker row", () => {
  const hunk: StructuredPatchHunk = {
    oldStart: 1,
    oldLines: 5,
    newStart: 1,
    newLines: 5,
    lines: [" ctx 1", " ctx 2", "-old 1", "+new 1", " ctx 3"],
  };
  const full = String(
    renderToString(React.createElement(StructuredDiffList, { hunks: [hunk], width: 40 }), {
      columns: 40,
    }),
  );

  // All five hunk lines — nothing dropped from the tail.
  expect(full.split("\n")).toHaveLength(5);
  expect(full).toContain("ctx 1");
  expect(full).toContain("new 1");
  expect(full).toContain("ctx 3");
  expect(full).not.toContain("…");
});

// A Write over an existing file is a normal update diff.
test("an overwritten file renders as hunks", () => {
  const spans = buildToolBlockSpans(
    toolBlock(
      "Write",
      ["Wrote src/bar.ts (3 lines)", "", "Diff preview:", "@@ -1,1 +1,2 @@\n+export const x = 1;\n"].join("\n"),
    ),
    CONTENT_WIDTH,
    false,
    dark,
  );

  expect(spans[0]!.key).toBe("stats");
  const rows = rowsOf(diffSpans(spans)[0]!);
  expect(rows.map((r) => r.gutter)).toEqual([" 1 +"]);
});
