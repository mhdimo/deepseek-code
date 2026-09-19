import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render } from "ink";

import Markdown, {
  flattenMarkdown,
  markdownRows,
  updateMarkdownModel,
  type MarkdownBlockRows,
} from "../../src/components/Markdown.js";
import ThinkingBlock from "../../src/components/ThinkingBlock.js";

/** Text of every row of a markdown document (blank rows are ""). */
function rowsOf(content: string, width = 80): string[] {
  return flattenMarkdown(markdownRows(content, width, false, "gray")).map((r) =>
    r.runs.map((x) => x.text).join(""),
  );
}

/** Runs of the first row of the first block (for style assertions). */
function firstRowRuns(model: MarkdownBlockRows[]) {
  return model[0]!.rows[0]!.runs;
}

// --- tables (ported from MarkdownTable.tsx) --------------------------------

test("tables render as a bordered box, not a bare rule under the header", () => {
  // Claude Code draws ┌─┬─┐ / │ a │ b │ / ├─┼─┤ / │ 1 │ 2 │ / └─┴─┘.
  expect(rowsOf("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual([
    "┌─────┬─────┐",
    "│  a  │  b  │",
    "├─────┼─────┤",
    "│ 1   │ 2   │",
    "└─────┴─────┘",
  ]);
});

test("every data row is separated by a ├─┼─┤ border", () => {
  expect(rowsOf("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |")).toEqual([
    "┌─────┬─────┐",
    "│  a  │  b  │",
    "├─────┼─────┤",
    "│ 1   │ 2   │",
    "├─────┼─────┤",
    "│ 3   │ 4   │",
    "└─────┴─────┘",
  ]);
});

test("table headers are centered and unstyled; data honours alignment", () => {
  const model = markdownRows("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |", 80, false, "gray");
  // Row 0 is the top border; row 1 is the header. Header cells are centered
  // in their column, and not bold.
  const header = model[0]!.rows[1]!.runs;
  expect(header.map((r) => r.text)).toEqual(["│  a  │  b  │  c  │"]);
  expect(header.every((r) => r.style?.bold !== true)).toBe(true);
  // Data cells: left / center / right from the :-- alignment row.
  expect(model[0]!.rows.map((r) => r.runs.map((x) => x.text).join(""))).toEqual([
    "┌─────┬─────┬─────┐",
    "│  a  │  b  │  c  │",
    "├─────┼─────┼─────┤",
    "│ 1   │  2  │   3 │",
    "└─────┴─────┴─────┘",
  ]);
});

test("a table that cannot fit its box falls back to key/value lines", () => {
  // Five columns at width 30 overflow the SAFETY_MARGIN, so the reference
  // prints `Label: value` rows instead of a clipped grid.
  expect(rowsOf("| h1 | h2 | h3 | h4 | h5 |\n|---|---|---|---|---|\n| a | b | c | d | e |", 30)).toEqual([
    "h1: a",
    "h2: b",
    "h3: c",
    "h4: d",
    "h5: e",
  ]);
});

test("a row taller than four wrapped lines falls back to key/value lines", () => {
  // The other half of MarkdownTable's vertical rule (MAX_ROW_LINES = 4). The
  // grid itself WOULD fit: column widths come out 10/3/3, so the bordered
  // line is 26 cols at width 30 — inside SAFETY_MARGIN. It is the six-line
  // "a" cell, not the width check, that forces the fallback here.
  expect(
    rowsOf("| a | b | c |\n|---|---|---|\n| alpha bravo charlie delta echo foxtrot | x | y |", 30),
  ).toEqual(["a: alpha bravo charlie delta", "  echo foxtrot", "b: x", "c: y"]);
});

test("vertical records are separated by a ─ rule, continuations indented two", () => {
  // min(terminalWidth - 1, 40) = 29 dashes between records.
  expect(
    rowsOf(
      "| a | b | c |\n|---|---|---|\n| alpha bravo charlie delta echo foxtrot | x | y |\n| golf hotel india | p | q |",
      30,
    ),
  ).toEqual([
    "a: alpha bravo charlie delta",
    "  echo foxtrot",
    "b: x",
    "c: y",
    "─".repeat(29),
    "a: golf hotel india",
    "b: p",
    "c: q",
  ]);
});

// --- blockquotes -----------------------------------------------------------

test("a multi-line blockquote has no blank row between its lines", () => {
  expect(rowsOf("> one\n> two")).toEqual(["▎ one", "▎ two"]);
});

test("a wrapped blockquote continuation starts at column 0 with no bar", () => {
  expect(rowsOf("> aaa bbb ccc ddd", 10)).toEqual(["▎ aaa bbb ", "ccc ddd"]);
});

test("blank lines inside a blockquote keep their row but get no bar", () => {
  expect(rowsOf("> one\n>\n> two")).toEqual(["▎ one", "", "▎ two"]);
});

// --- block spacing ---------------------------------------------------------

test("a heading is followed by exactly one blank row", () => {
  expect(rowsOf("# Hi\n\nText after heading")).toEqual([
    "Hi",
    "",
    "Text after heading",
  ]);
});

test("a horizontal rule has air above it and none below", () => {
  expect(rowsOf("Some text\n\n---\n\nMore text")).toEqual([
    "Some text",
    "",
    "---",
    "More text",
  ]);
});

// --- headings --------------------------------------------------------------

test("h1 is bold, italic and underlined; h2 is bold only", () => {
  const h1 = firstRowRuns(markdownRows("# H1", 80, false, "gray"))[0]!.style;
  expect(h1).toMatchObject({ bold: true, italic: true, underline: true });
  const h2 = firstRowRuns(markdownRows("## H2", 80, false, "gray"))[0]!.style;
  expect(h2).toMatchObject({ bold: true });
  expect(h2?.italic).toBeUndefined();
});

// --- paragraphs and lists --------------------------------------------------

test("paragraph source line breaks are kept instead of being re-flowed", () => {
  expect(rowsOf("line one\nline two\nline three", 60)).toEqual([
    "line one",
    "line two",
    "line three",
  ]);
});

test("nested list items indent two columns per nesting level", () => {
  // Four spaces of source indentation is ONE nesting level in marked, so
  // the item sits two columns in — and the indent is part of the row text,
  // so a wrapped continuation starts at column 0.
  expect(rowsOf("- a\n    - b\n- c")).toEqual(["- a", "", "  - b", "", "- c"]);
  const rows = flattenMarkdown(markdownRows("- a\n    - b\n- c", 80, false, "gray"));
  expect(rows.map((r) => r.origin ?? 0)).toEqual([0, 0, 0, 0, 0]);
});

test("streaming a nested list keeps the depth of a full re-parse", () => {
  // List depth spans lines, so the incremental tail re-parse has to resume
  // with the nesting it left off at — otherwise a nested item renders at
  // column 0 until something forces a full re-parse.
  const doc = "- a\n    - b\n        - c";
  let state = updateMarkdownModel("", 80, false, "gray", null);
  for (let i = 1; i <= doc.length; i++) {
    state = updateMarkdownModel(doc.slice(0, i), 80, false, "gray", state);
  }
  const full = rowsOf(doc);
  expect(flattenMarkdown(state.model).map((r) => r.runs.map((x) => x.text).join(""))).toEqual(full);
  expect(full).toEqual(["- a", "", "  - b", "", "      - c"]);
});

test("nested ordered lists use the reference's marker scheme", () => {
  // depth 0 → decimal, depth 1 → letter, depth 2 → roman.
  expect(rowsOf("1. a\n    1. b\n        1. c")).toEqual([
    "1. a",
    "",
    "  a. b",
    "",
    "      i. c",
  ]);
});

test("nesting indents are 2 then +4 per level, not two per level", () => {
  // The reference's list_item prefixes `'  '.repeat(listDepth)` to each child
  // and recurses with listDepth + 1; marked nests a sub-list INSIDE its parent
  // item's tokens (list_item → [text, list]). A nested list's string is
  // multi-line, so the parent's prefix lands on its FIRST line only — the
  // stacking stops there. Measured indents: 0, 2, 6, 10, 14, 18.
  expect(rowsOf("- a\n    - b\n        - c\n            - d")).toEqual([
    "- a",
    "",
    "  - b",
    "",
    "      - c",
    "",
    "          - d",
  ]);
});

// --- thinking block labels -------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

async function renderFrame(node: React.ReactElement): Promise<string> {
  let out = "";
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
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
  return out.replace(ANSI, "");
}

test("the bordered table survives the ink layout (one screen row per line)", async () => {
  const frame = await renderFrame(
    React.createElement(Markdown, { width: 80, children: "| a | b |\n|---|---|\n| 1 | 2 |" }),
  );
  const lines = frame.split("\n").map((l) => l.trimEnd());
  expect(lines).toContain("┌─────┬─────┐");
  expect(lines).toContain("│  a  │  b  │");
  expect(lines).toContain("├─────┼─────┤");
  expect(lines).toContain("│ 1   │ 2   │");
  expect(lines).toContain("└─────┴─────┘");
});

test("a settled collapsed thinking block says ∴ Thinking, with no duration", async () => {
  const frame = await renderFrame(
    React.createElement(ThinkingBlock, {
      content: "weighing the options",
      width: 80,
      isStreaming: false,
      thinkingStart: 1_000,
      thinkingEnd: 13_000,
    }),
  );
  expect(frame).toContain("∴ Thinking (ctrl+o to expand)");
  expect(frame).not.toContain("Thought");
  expect(frame).not.toContain("12s");
});

test("the expanded thinking header is ∴ Thinking…, with no duration", async () => {
  const frame = await renderFrame(
    React.createElement(ThinkingBlock, {
      content: "weighing the options",
      isTranscriptMode: true,
      width: 80,
      thinkingStart: 1_000,
      thinkingEnd: 43_000,
    }),
  );
  expect(frame).toContain("∴ Thinking…");
  expect(frame).not.toContain("Thought");
  expect(frame).not.toContain("42s");
});
