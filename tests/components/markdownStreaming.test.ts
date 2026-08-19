import { expect, test } from "bun:test";

import {
  markdownRows,
  updateMarkdownModel,
  flattenMarkdown,
  type MarkdownModelState,
} from "../../src/components/Markdown.js";

function rowTextOf(model: ReturnType<typeof markdownRows>): string {
  return flattenMarkdown(model)
    .map((r) => r.runs.map((x) => x.text).join(""))
    .join("\n");
}

// Regression: marker-only lines ("## ", "- ", "1. ") arrive mid-stream
// while the model is still typing the block content. The old parser left
// them for the paragraph branch, whose terminator matched but whose
// consumer didn't — neither branch advanced and the render loop spun
// forever (the TUI froze on every flush that caught a partial marker).
test("marker-only lines parse without hanging", () => {
  const cases = [
    "## ",
    "### ",
    "# ",
    "- ",
    "* ",
    "+ ",
    "1. ",
    "10. ",
    "   - ",
    "--- ",
    "> ",
    "```",
  ];
  for (const c of cases) {
    const model = markdownRows(c, 100, false, "gray");
    expect(model.length).toBeGreaterThan(0);
    expect(model[0]!.block.type).not.toBe("paragraph");
  }
});

// The complete-stream equivalent of the marker-only lines: once the model
// finishes the marker, the block must look like a normal heading/list.
test("marker-only lines extend into real blocks", () => {
  expect(markdownRows("## Done", 100, false, "gray")[0]!.block.type).toBe("heading");
  expect(markdownRows("- item", 100, false, "gray")[0]!.block.type).toBe("list-item");
  expect(markdownRows("1. item", 100, false, "gray")[0]!.block.type).toBe("list-item");
});

test("incremental updates match full parses for append-only streams", () => {
  const fragments = [
    "plain paragraph line",
    "## Heading with **bold**",
    "> quote line",
    "- list item one",
    "- a\n- b\n- c",
    "1. ordered\n2. second\n3. third",
    "```ts\nconst x = 1;\n```",
    "```\ncode inside\n",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "---",
    "para one\n\npara two",
    "**bold** and `code` and [link](https://x.com)",
    "para\n```\nfence opens after para",
    "```\nfence\n```\ntext after fence",
    "> q1\n> q2\n\nnormal",
    "- item with **bold**\n- item two",
    "trailing whitespace   ",
    "emoji 🚀 and wide 中文 text",
    "5. starts at five\n6. six",
  ];
  for (const frag of fragments) {
    const ref = markdownRows(frag, 100, false, "gray");
    let state: MarkdownModelState | null = null;
    for (let i = 1; i <= frag.length; i++) {
      state = updateMarkdownModel(frag.slice(0, i), 100, false, "gray", state);
    }
    expect(rowTextOf(state!.model)).toBe(rowTextOf(ref));
    expect(state!.model.map((b) => b.block.type + ":" + b.rows.length).join(",")).toBe(
      ref.map((b) => b.block.type + ":" + b.rows.length).join(","),
    );
  }
});

test("incremental state handles idempotence, shrink, and width changes", () => {
  const doc = "para one\n\n## Heading\n\n- a\n- b\n\n1. x\n2. y";
  let state: MarkdownModelState | null = updateMarkdownModel(doc, 100, false, "gray", null);
  // Same content again (stream finalize re-render) — no re-parse, same model.
  const again = updateMarkdownModel(doc, 100, false, "gray", state);
  expect(again).toBe(state);
  // Shrink (e.g. /clear then re-render of an old message) — full re-parse.
  state = updateMarkdownModel(doc.slice(0, 20), 100, false, "gray", state);
  expect(rowTextOf(state!.model)).toBe(rowTextOf(markdownRows(doc.slice(0, 20), 100, false, "gray")));
  // Width change re-wraps.
  state = updateMarkdownModel(doc.slice(0, 20), 60, false, "gray", state);
  expect(rowTextOf(state!.model)).toBe(rowTextOf(markdownRows(doc.slice(0, 20), 60, false, "gray")));
  // Dim/color change re-parses.
  state = updateMarkdownModel(doc.slice(0, 20), 60, true, "red", state);
  expect(rowTextOf(state!.model)).toBe(rowTextOf(markdownRows(doc.slice(0, 20), 60, true, "red")));
});

test("ordered lists render their source numbers", () => {
  const model = markdownRows("1. first\n2. second", 100, false, "gray");
  expect(rowTextOf(model)).toBe("1. first\n\n2. second");
  const model2 = markdownRows("3. three\n4. four", 100, false, "gray");
  expect(rowTextOf(model2)).toBe("3. three\n\n4. four");
});

test("unchanged blocks keep identity across incremental updates", () => {
  // Identity stability is what lets MemoBlock skip re-rendering: blocks
  // before the appended tail must be the SAME object references.
  let state: MarkdownModelState | null = null;
  state = updateMarkdownModel("## One\n\npara two\n\n- item", 100, false, "gray", state);
  const headingBlock = state!.model[0]!;
  const paraBlock = state!.model[1]!;
  const oldItemRows = state!.model[2]!.rows;
  // Appending to the LAST block replaces only it; earlier blocks keep their
  // exact object identity (rows included) so MemoBlock bails out.
  state = updateMarkdownModel("## One\n\npara two\n\n- item more", 100, false, "gray", state);
  expect(state!.model[0]).toBe(headingBlock);
  expect(state!.model[1]).toBe(paraBlock);
  expect(state!.model[2]!.rows).not.toBe(oldItemRows);
});
