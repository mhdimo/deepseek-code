import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render } from "ink";

import ToolBlock, {
  BLACK_CIRCLE,
  TOOL_OUT_LEFT,
  TOOL_RESULT_PREFIX,
  buildToolBlockSpans,
  errorBodyText,
  formatElapsed,
  formatToolArgs,
  rejectionRuns,
  toolLabel,
  type ToolBlockSpan,
} from "../../src/components/ToolBlock.js";
import { getTheme, resolveColor } from "../../src/utils/theme.js";
import type { StyledRun } from "../../src/services/selection/lineModel.js";
import type { ToolUseBlock } from "../../src/types/index.js";

const dark = getTheme("dark");

const CONTENT_WIDTH = 96;

const toolBlock = (over: { toolName: string } & Record<string, unknown>): ToolUseBlock =>
  // The stream hands the block a parsed input object; the type says string.
  ({ status: "done", ...over }) as unknown as ToolUseBlock;

const rowsOf = (span: ToolBlockSpan): string[] =>
  span.rows.map((r) => r.runs.map((x) => x.text).join(""));

const spanText = (span: ToolBlockSpan): string => rowsOf(span).join("\n");

const runs = (span: ToolBlockSpan): StyledRun[] => span.rows.flatMap((r) => r.runs);

const spanByKey = (spans: ToolBlockSpan[], key: string): ToolBlockSpan => {
  const span = spans.find((s) => s.key === key);
  if (!span) throw new Error(`no span ${key} (have ${spans.map((s) => s.key).join(", ")})`);
  return span;
};

const spansFor = (block: ToolUseBlock, transcript = false): ToolBlockSpan[] =>
  buildToolBlockSpans(block, CONTENT_WIDTH, transcript, dark);

const editOutput = (hunks: string): string => ["Edited src/foo.ts", "", "Diff preview:", hunks].join("\n");

/* ---------------------------------------------------------------- labels */

test("Edit is labelled Update, and Create when it starts from an empty old_string", () => {
  // FileEditTool/UI.tsx userFacingName.
  expect(toolLabel("Edit", { file_path: "src/foo.ts", old_string: "a", new_string: "b" })).toBe("Update");
  expect(toolLabel("Edit", { file_path: "src/foo.ts", old_string: "", new_string: "b" })).toBe("Create");
  expect(toolLabel("Edit", undefined)).toBe("Update");
  // The JSON-string input form the stream hands us parses the same way.
  expect(toolLabel("Edit", JSON.stringify({ old_string: "" }))).toBe("Create");
});

test("Glob and Grep share the reference's Search verb", () => {
  expect(toolLabel("Glob", { pattern: "src/**" })).toBe("Search");
  expect(toolLabel("Grep", { pattern: "TODO" })).toBe("Search");
});

/* --------------------------------------------------------------- subject */

test("Glob/Grep subjects carry the quoted named parameter", () => {
  // GlobTool/UI.tsx: `pattern: "…"`, plus `path: "…"` when one was given.
  expect(formatToolArgs("Glob", { pattern: "src/**/*.ts" })).toBe('pattern: "src/**/*.ts"');
  // A path outside the cwd has no shorter form, so it prints as given.
  expect(formatToolArgs("Grep", { pattern: "TODO", path: "/elsewhere/src" })).toBe(
    'pattern: "TODO", path: "/elsewhere/src"',
  );
  expect(formatToolArgs("Grep", { pattern: "TODO", path: `${process.cwd()}/src` })).toBe(
    'pattern: "TODO", path: "src"',
  );
});

test("Bash commands get the reference's 2-line / 160-char budget", () => {
  // BashTool/UI.tsx MAX_COMMAND_DISPLAY_CHARS.
  const long = "x".repeat(200);
  expect(formatToolArgs("Bash", { command: long })).toBe("x".repeat(160) + "…");
  // Right up to the budget there is no ellipsis.
  const atBudget = "y".repeat(160);
  expect(formatToolArgs("Bash", { command: atBudget })).toBe(atBudget);
  // MAX_COMMAND_DISPLAY_LINES: the third line is dropped — and only then is
  // the ellipsis appended. The survivors keep their line break: the reference
  // joins them with '\n' and returns the command itself when it fits.
  expect(formatToolArgs("Bash", { command: "one\ntwo\nthree" })).toBe("one\ntwo…");
  expect(formatToolArgs("Bash", { command: "one\ntwo" })).toBe("one\ntwo");
  // Character truncation alone still cuts across the line break (the
  // reference slices the joined command, it does not flatten it first).
  expect(formatToolArgs("Bash", { command: `one\n${"z".repeat(200)}` })).toBe(`one\n${"z".repeat(156)}…`);
});

/* --------------------------------------------------- collapsed summaries */

test("a collapsed Read result reads Read N lines, with the count bold", () => {
  // FileReadTool/UI.tsx renderToolResultMessage (text case).
  const block = toolBlock({ toolName: "Read", output: "a\nb\nc", input: { file_path: "src/foo.ts" } });
  const span = spanByKey(spansFor(block), "summary");

  expect(spanText(span)).toBe("Read 3 lines (ctrl+o to expand)");
  expect(runs(span).filter((r) => r.style?.bold).map((r) => r.text)).toEqual(["3"]);
});

test("a collapsed Read result of one line is singular", () => {
  const block = toolBlock({ toolName: "Read", output: "only line", input: { file_path: "src/foo.ts" } });
  expect(spanText(spanByKey(spansFor(block), "summary"))).toBe("Read 1 line (ctrl+o to expand)");
});

test("a collapsed Write create reads Wrote N lines to <path>", () => {
  // FileWriteToolCreatedMessage.
  const block = toolBlock({
    toolName: "Write",
    input: { file_path: "src/bar.ts", content: "a\nb\nc" },
    output: "Wrote src/bar.ts (3 lines)",
  });
  const span = spanByKey(spansFor(block), "summary");

  expect(spanText(span)).toBe("Wrote 3 lines to src/bar.ts (ctrl+o to expand)");
  const bold = runs(span).filter((r) => r.style?.bold).map((r) => r.text);
  expect(bold).toEqual(["3", expect.stringContaining("bar.ts")]);
});

test("a collapsed Edit result keeps the reference's stats wording", () => {
  const block = toolBlock({
    toolName: "Edit",
    input: { file_path: "src/foo.ts" },
    output: editOutput("@@ -1,2 +1,3 @@\n-const b = oldValue;\n+const b = newValue;\n"),
  });
  expect(spanText(spanByKey(spansFor(block), "summary"))).toBe(
    "Added 1 line, removed 1 line (ctrl+o to expand)",
  );
});

test("a collapsed NotebookEdit result names the cell", () => {
  // NotebookEditTool/UI.tsx renderToolResultMessage: "Updated cell N:".
  const block = toolBlock({
    toolName: "NotebookEdit",
    input: { notebook_path: "src/nb.ipynb", cell_number: 3 },
    output: "Replaced cell 3 (code). Source:\nx = 1",
  });
  const span = spanByKey(spansFor(block), "summary");

  expect(spanText(span)).toBe("Updated cell 3: (ctrl+o to expand)");
  expect(runs(span).filter((r) => r.style?.bold).map((r) => r.text)).toEqual(["3"]);
});

test("other tools fold their output at 3 lines with the reference's marker", () => {
  // renderTruncatedContent: MAX_LINES_TO_SHOW = 3, "… +N lines (ctrl+o to expand)".
  const six = toolBlock({ toolName: "Bash", input: { command: "seq 6" }, output: "1\n2\n3\n4\n5\n6" });
  const span = spanByKey(spansFor(six), "summary");

  expect(rowsOf(span)).toEqual(["1", "2", "3", "… +3 lines (ctrl+o to expand)"]);
  expect(runs(span).at(-1)!.style?.dim).toBe(true);

  // wrapText's remainingLines === 1 special case: the one leftover line is
  // shown instead of a marker.
  const four = toolBlock({ toolName: "Bash", input: { command: "seq 4" }, output: "1\n2\n3\n4" });
  expect(rowsOf(spanByKey(spansFor(four), "summary"))).toEqual(["1", "2", "3", "4"]);
});

/* -------------------------------------------------------------- rejected */

test("a rejected tool result is a body line, not a ✗ head row", () => {
  // RejectedToolUseMessage: the call's row stays, the body says the rejection.
  const block = toolBlock({ toolName: "Bash", status: "rejected", input: { command: "rm -rf /" } });
  const spans = spansFor(block);
  const span = spanByKey(spans, "rejected");

  expect(spanText(span)).toBe("Tool use rejected");
  expect(runs(span).every((r) => r.style?.dim)).toBe(true);
  expect(spanText(span)).not.toContain("✗");
});

test("an interrupted tool result carries the InterruptedByUser line", () => {
  const block = toolBlock({ toolName: "Read", status: "interrupted" });
  const span = spanByKey(spansFor(block), "rejected");

  expect(spanText(span)).toBe("Interrupted · What should Claude do instead?");
  expect(runs(span).every((r) => r.style?.dim)).toBe(true);
});

test("a rejected Edit names itself the way FileEditToolUseRejectedMessage does", () => {
  const block = toolBlock({
    toolName: "Edit",
    status: "rejected",
    input: { file_path: `${process.cwd()}/src/foo.ts`, old_string: "a", new_string: "b" },
  });
  const span = spanByKey(spansFor(block), "rejected");

  expect(spanText(span)).toBe("User rejected update to src/foo.ts");
  expect(runs(span).every((r) => r.style?.color === resolveColor(dark.subtle))).toBe(true);
  expect(runs(span)[1]!.style?.bold).toBe(true);
});

test("a rejected Edit that creates the file says write, as the reference does", () => {
  const block = toolBlock({
    toolName: "Edit",
    status: "rejected",
    input: { file_path: "src/new.ts", old_string: "", new_string: "b" },
  });
  expect(spanText(spanByKey(spansFor(block), "rejected"))).toBe("User rejected write to src/new.ts");
});

test("a rejected NotebookEdit names the cell", () => {
  const block = toolBlock({
    toolName: "NotebookEdit",
    status: "rejected",
    input: { notebook_path: "src/nb.ipynb", cell_number: 2, edit_mode: "replace" },
  });
  expect(spanText(spanByKey(spansFor(block), "rejected"))).toBe(
    "User rejected replace cell in src/nb.ipynb at cell 2",
  );
});

/* ----------------------------------------------------------------- error */

test("a failed tool reads Error: <output>, capped at 10 lines with the see-all fold", () => {
  // FallbackToolUseErrorMessage: MAX_RENDERED_LINES = 10.
  const block = toolBlock({
    toolName: "Bash",
    status: "error",
    input: { command: "false" },
    output: Array.from({ length: 12 }, (_, i) => `boom ${i + 1}`).join("\n"),
  });
  const spans = spansFor(block);
  const body = rowsOf(spanByKey(spans, "error"));

  expect(body.slice(0, 2)).toEqual(["Error: boom 1", "boom 2"]);
  expect(body).toHaveLength(10);
  expect(runs(spanByKey(spans, "error")).every((r) => r.style?.color === resolveColor(dark.error))).toBe(true);
  expect(spanText(spanByKey(spans, "error-truncated"))).toBe("… +2 lines (ctrl+o to see all)");
});

test("an error already labelled Error:/Cancelled: is not labelled twice", () => {
  expect(errorBodyText("Error: file is gone")).toBe("Error: file is gone");
  expect(errorBodyText("Cancelled: the user stopped it")).toBe("Cancelled: the user stopped it");
  expect(errorBodyText("  \n plain failure \n ")).toBe("Error: plain failure");
  // The tag wrappers are for the model, not the screen.
  expect(errorBodyText("<tool_use_error>kaboom</tool_use_error>")).toBe("Error: kaboom");
  expect(errorBodyText("<error>kaboom</error>")).toBe("Error: kaboom");
});

/* --------------------------------------------------------------- running */

test("a running command shows its last 5 output lines and the +N status", () => {
  // ShellProgressMessage: lines.slice(-5) plus "+N lines".
  const block = toolBlock({
    toolName: "Bash",
    status: "running",
    input: { command: "seq 8" },
    output: Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n"),
  });
  const spans = spansFor(block);

  expect(rowsOf(spanByKey(spans, "progress"))).toEqual(["line 4", "line 5", "line 6", "line 7", "line 8"]);
  expect(spanText(spanByKey(spans, "progress-status"))).toBe("+3 lines");
});

test("a running command with no output yet says Running…", () => {
  const block = toolBlock({ toolName: "Bash", status: "running", input: { command: "sleep 5" } });
  expect(spanText(spanByKey(spansFor(block), "progress"))).toBe("Running… ");
});

test("a running tool that is not a shell gets no progress line", () => {
  const block = toolBlock({ toolName: "Read", status: "running", input: { file_path: "src/foo.ts" } });
  expect(spansFor(block)).toEqual([]);
});

test("a finished shell command with no output says (No output)", () => {
  // BashToolResultMessage renders "(No output)" when both streams are empty.
  const block = toolBlock({ toolName: "Bash", input: { command: "mkdir foo" }, output: "" });
  const span = spanByKey(spansFor(block), "no-output");

  expect(spanText(span)).toBe("(No output)");
  expect(runs(span).every((r) => r.style?.dim)).toBe(true);
  // Read has no such line in the reference — only the shell result message does.
  expect(spansFor(toolBlock({ toolName: "Read", input: { file_path: "src/x.ts" }, output: "" }))).toEqual([]);
});

test("a silent shell command's model-facing placeholder draws as (No output)", () => {
  // BashTool.ts settles on "(no output)" (`settle(text || "(no output)")`), so
  // an empty stdout/stderr reaches the renderer as that placeholder rather
  // than as "". BashToolResultMessage's dim "(No output)" is the screen line.
  const block = toolBlock({ toolName: "Bash", input: { command: "mkdir foo" }, output: "(no output)" });
  const span = spanByKey(spansFor(block), "no-output");

  expect(spanText(span)).toBe("(No output)");
  expect(runs(span).every((r) => r.style?.dim)).toBe(true);
  // The reference draws it regardless of the fold, so transcript mode too.
  expect(spanText(spanByKey(spansFor(block, true), "no-output"))).toBe("(No output)");
  // PowerShellTool settles on the same placeholder.
  expect(
    spanText(spanByKey(spansFor(toolBlock({ toolName: "PowerShell", output: "(no output)" })), "no-output")),
  ).toBe("(No output)");
  // A real command that printed that text is not a shell, so it is untouched.
  const repl = toolBlock({ toolName: "REPL", output: "(no output)" });
  expect(spansFor(repl).some((s) => s.key === "no-output")).toBe(false);
});

test("ShellTimeDisplay's clock formats whole seconds, then minutes", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(3)).toBe("3s");
  expect(formatElapsed(59)).toBe("59s");
  expect(formatElapsed(65)).toBe("1m 5s");
  expect(formatElapsed(3725)).toBe("1h 2m 5s");
});

/* --------------------------------------------------------------- colours */

test("command output is not dimmed — the reference paints stdout plainly", () => {
  // OutputLine's Text has no colour for stdout; only the fold marker and the
  // running tail are dim.
  const raw = toolBlock({ toolName: "Bash", isExpanded: true, input: { command: "ls" }, output: "a\nb" });
  const rawRows = runs(spanByKey(spansFor(raw), "raw"));
  expect(rawRows.some((r) => r.style?.dim)).toBe(false);

  const folded = toolBlock({ toolName: "Bash", input: { command: "seq 6" }, output: "1\n2\n3\n4\n5\n6" });
  const summary = spanByKey(spansFor(folded), "summary");
  const content = (row: { runs: { text: string; style?: { dim?: boolean } }[] }) =>
    row.runs.filter((r) => !r.text.includes("(ctrl+o to expand)"));
  expect(summary.rows.slice(0, 3).every((row) => content(row).every((r) => !r.style?.dim))).toBe(true);
  expect(runs(summary).at(-1)!.style?.dim).toBe(true);

  const read = toolBlock({ toolName: "Read", input: { file_path: "src/foo.ts" }, output: "a\nb\nc" });
  const readSummary = spanByKey(spansFor(read), "summary");
  expect(content(readSummary.rows[0]!).every((r) => !r.style?.dim)).toBe(true);
});

/* ------------------------------------------------------------------ diff */

test("every hunk of an Edit result is rendered — no cap and no marker row", () => {
  // FileEditToolUpdatedMessage hands the whole structuredPatch to
  // StructuredDiffList, which has no row budget; ours kept 200 rows and
  // closed with a "… (N more lines)" row the reference never draws.
  const chunks: string[] = [];
  for (let h = 0; h < 3; h++) {
    const start = 1 + h * 400;
    const lines = [`@@ -${start},120 +${start},121 @@`];
    for (let i = 0; i < 120; i++) lines.push(` const ctx${i} = ${i};`);
    lines.push(`+const added${h} = ${h};`);
    chunks.push(lines.join("\n"));
  }
  const block = toolBlock({
    toolName: "Edit",
    isExpanded: true,
    input: { file_path: "src/foo.ts" },
    output: editOutput(chunks.join("\n")),
  });
  const spans = spansFor(block);

  expect(spans.map((s) => s.key)).toEqual(["stats", "diff-0", "sep-1", "diff-1", "sep-2", "diff-2"]);
  const diffRows = spans.reduce((n, s) => n + (s.diff ? s.rowCount : 0), 0);
  expect(diffRows).toBeGreaterThan(200);
  // The last hunk's added line survives.
  const last = spans.find((s) => s.key === "diff-2")!;
  expect(last.diff!.some((r) => r.runs.map((x) => x.text).join("").includes("added2"))).toBe(true);
});

test("an expanded result renders every line — no row budget, no fold marker row", () => {
  // OutputLine with verbose (ctrl+o) shows the whole output; the fold belongs
  // to renderTruncatedContent, which verbose skips. Ours used to keep 200 rows
  // and close with "… (N more lines)", a row the reference never draws.
  const all = Array.from({ length: 260 }, (_, i) => `line ${i + 1}`);
  const block = toolBlock({
    toolName: "Bash",
    isExpanded: true,
    input: { command: "seq 260" },
    output: all.join("\n"),
  });
  const span = spanByKey(spansFor(block), "raw");

  expect(span.rowCount).toBe(260);
  expect(spanText(span)).not.toContain("more lines");
  expect(spanText(span)).toContain("line 260");
  // Transcript mode is the same view with more rows, not a different budget.
  expect(spanByKey(spansFor(block, true), "raw").rowCount).toBe(260);
});

/* ------------------------------------------------------------- rendering */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

/** Drive the real component through Ink and read the frame back. */
async function renderFrame(node: React.ReactElement, columns = 100): Promise<string> {
  let out = "";
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

const frameOf = async (block: ToolUseBlock, transcript = false): Promise<string[]> =>
  (await renderFrame(
    React.createElement(ToolBlock, {
      block,
      spans: buildToolBlockSpans(block, CONTENT_WIDTH, transcript, dark),
      startRow: 1,
      contentWidth: CONTENT_WIDTH,
      theme: dark,
    }),
  ))
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");

test("the result body renders under the ⎿ hook at column 5", async () => {
  expect(TOOL_OUT_LEFT).toBe(5);
  expect(TOOL_RESULT_PREFIX).toBe("  ⎿  ");

  const block = toolBlock({ toolName: "Read", output: "a\nb\nc", input: { file_path: "src/foo.ts" } });
  const lines = await frameOf(block);

  // Head row: ● at column 0, as in AssistantToolUseMessage.
  expect(lines[0]).toBe(`${BLACK_CIRCLE} Read(src/foo.ts)`);
  // Body: the hook at column 2, the body's text at column 5.
  expect(lines[1]).toBe("  ⎿  Read 3 lines (ctrl+o to expand)");
});

test("the Read summary's ctrl+o hint is truthful — transcript mode draws the file body", async () => {
  // FileReadTool/UI.tsx's renderToolResultMessage takes no verbose and prints
  // only "Read N lines", so the hint on our collapsed Read is ours alone. It
  // is only honest while expanding really shows the file the fold hid: if a
  // parity pass drops the transcript body, drop the hint with it.
  const block = toolBlock({
    toolName: "Read",
    input: { file_path: "src/foo.ts" },
    output: "     1→const a = 1;\n     2→const b = 2;",
  });

  const collapsed = (await frameOf(block)).join("\n");
  expect(collapsed).toContain("Read 2 lines (ctrl+o to expand)");
  expect(collapsed).not.toContain("const a = 1");

  const transcript = (await frameOf(block, true)).join("\n");
  expect(transcript).toContain("const a = 1");
  expect(transcript).toContain("const b = 2");
  expect(transcript).not.toContain("(ctrl+o to expand)");
});

test("a rejected tool keeps its call row and states the rejection below", async () => {
  const block = toolBlock({ toolName: "Bash", status: "rejected", input: { command: "rm -rf /tmp/x" } });
  const lines = await frameOf(block);

  expect(lines[0]).toBe(`${BLACK_CIRCLE} Bash(rm -rf /tmp/x)`);
  expect(lines[1]).toBe("  ⎿  Tool use rejected");
  expect(lines.join("\n")).not.toContain("✗");
  expect(lines.join("\n")).not.toContain("[rejected]");
});

test("an interrupted tool renders the InterruptedByUser line", async () => {
  const block = toolBlock({ toolName: "Bash", status: "interrupted", input: { command: "sleep 99" } });
  const lines = await frameOf(block);

  expect(lines[1]).toBe("  ⎿  Interrupted · What should Claude do instead?");
});

test("a running command renders its live tail under the hook", async () => {
  const block = toolBlock({
    toolName: "Bash",
    status: "running",
    input: { command: "npm run build" },
    output: "one\ntwo\nthree",
  });
  const lines = await frameOf(block);

  expect(lines[0]).toBe(`${BLACK_CIRCLE} Bash(npm run build)`);
  expect(lines[1]).toBe("  ⎿  one");
  expect(lines[2]).toBe("     two");
  expect(lines[3]).toBe("     three");
  // ShellProgressMessage's status row: the fold status plus the clock.
  expect(lines.at(-1)).toBe("     (0s)");
});

test("a running command with output past 5 lines shows +N and the clock", async () => {
  const block = toolBlock({
    toolName: "Bash",
    status: "running",
    input: { command: "seq 8" },
    output: Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n"),
  });
  const lines = await frameOf(block);

  expect(lines.at(-1)).toBe("     +3 lines (0s)");
});

test("a running command with no output says Running… and the clock", async () => {
  const block = toolBlock({ toolName: "Bash", status: "running", input: { command: "sleep 5" } });
  const lines = await frameOf(block);

  expect(lines[1]).toBe("  ⎿  Running… (0s)");
});

test("a finished shell command with no output renders (No output)", async () => {
  const block = toolBlock({ toolName: "Bash", input: { command: "mkdir foo" }, output: "" });
  const lines = await frameOf(block);

  expect(lines[0]).toBe(`${BLACK_CIRCLE} Bash(mkdir foo)`);
  expect(lines[1]).toBe("  ⎿  (No output)");

  // What a silent `mkdir` actually carries: the tool's own placeholder.
  const silent = toolBlock({ toolName: "Bash", input: { command: "mkdir foo" }, output: "(no output)" });
  expect((await frameOf(silent))[1]).toBe("  ⎿  (No output)");
});

test("a multi-line Bash command keeps its second line on the head", async () => {
  // BashTool/UI.tsx returns the command itself under the 2-line budget, and
  // its Text draws the newline — the head is two rows, not one flattened one.
  const block = toolBlock({ toolName: "Bash", input: { command: "one\ntwo" }, output: "hi" });
  const lines = await frameOf(block);

  expect(lines[0]).toBe(`${BLACK_CIRCLE} Bash(one`);
  // The continuation starts at the text node's own origin — right after the
  // tool name — exactly as the reference's `(command)` renders it.
  expect(lines[1]).toBe("      two)");
  expect(lines[2]).toBe("  ⎿  hi");
});

test("a finished tool's head carries no elapsed time", async () => {
  // AssistantToolUseMessage's head is dot + name + (args) + tool tag.
  const block = toolBlock({
    toolName: "Bash",
    duration: 800,
    input: { command: "echo hi" },
    output: "hi",
  });
  const lines = await frameOf(block);

  expect(lines[0]).toBe(`${BLACK_CIRCLE} Bash(echo hi)`);
  expect(lines.join("\n")).not.toContain("0.8s");
});

test("the transcript bullet is the platform glyph", () => {
  // constants/figures.ts: '⏺' on darwin, '●' elsewhere.
  expect(BLACK_CIRCLE).toBe(process.platform === "darwin" ? "⏺" : "●");
});

test("rejectionRuns is RejectedToolUseMessage's line for a tool without its own", () => {
  expect(rejectionRuns(toolBlock({ toolName: "WebFetch", status: "rejected" }), dark)).toEqual([
    { text: "Tool use rejected", style: { dim: true } },
  ]);
});
