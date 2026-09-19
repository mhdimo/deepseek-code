import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, type DOMElement } from "ink";
import type { ToolUseBlock } from "../types/index.js";
import { resolveColor, type Theme } from "../utils/theme.js";
import { redactSecrets } from "../utils/redact.js";
import stringWidth from "string-width";
import {
  buildDiffModel,
  DiffRow,
  parseDiffTextToHunks,
  type DiffRowModel,
} from "./StructuredDiff.js";
import { RowText, rowSelection } from "./Markdown.js";
import type { TextRow, StyledRun } from "../services/selection/lineModel.js";
import { wrapTextRuns, wrapLineRuns } from "../services/selection/lineModel.js";
import type { ContentSelection } from "./useMouseSelection.js";
import type { StructuredPatchHunk } from "diff";

let blinkState = true;
const listeners = new Set<() => void>();
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    blinkState = !blinkState;
    listeners.forEach((l) => l());
  }, 400);
}

const blinkStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot() {
    return blinkState;
  },
};

export function useBlink() {
  return useSyncExternalStore(blinkStore.subscribe, blinkStore.getSnapshot);
}

/** Seconds the call has been running (ShellTimeDisplay's clock). The
 *  reference reads the engine's per-second progress events; we only know
 *  when the block first rendered, so the timer is anchored there. */
export function useElapsedSeconds(active: boolean): number | undefined {
  const startRef = useRef(Date.now());
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    startRef.current = Date.now();
    setSeconds(0);
    const id = setInterval(
      () => setSeconds(Math.floor((Date.now() - startRef.current) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [active]);
  return active ? seconds : undefined;
}

/** The transcript's bullet (constants/figures.ts): macOS gets the terminal
 *  dot, which sits better on the line but is not usually available on
 *  Windows/Linux, so those keep the filled circle. */
export const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

/** Column where the tool's output area begins. Claude Code renders every
 *  tool result inside MessageResponse, whose prefix is "  ⎿  " (two spaces,
 *  the hook, two spaces — utils/terminal.ts documents it as the 5-column
 *  "  ⎿ " prefix). The body therefore starts at column 5, with the ⎿ hook
 *  at column 2; the head row's ● stays at column 0 on both sides. */
export const TOOL_OUT_LEFT = 5;

/** MessageResponse's prefix, verbatim (components/MessageResponse.tsx). */
export const TOOL_RESULT_PREFIX = "  ⎿  ";

/** renderTruncatedContent (utils/terminal.ts, MAX_LINES_TO_SHOW) folds shell
 *  and tool output after 3 rendered lines. */
const MAX_LINES_TO_SHOW = 3;
/** FallbackToolUseErrorMessage's MAX_RENDERED_LINES. */
const MAX_ERROR_RENDERED_LINES = 10;
/** ShellProgressMessage renders a running command's last 5 output lines. */
const MAX_PROGRESS_LINES = 5;
/** BashTool/UI.tsx's command display budget (MAX_COMMAND_DISPLAY_*). */
const MAX_COMMAND_DISPLAY_LINES = 2;
const MAX_COMMAND_DISPLAY_CHARS = 160;

/** ctrlOToExpand() — components/CtrlOToExpand.tsx. */
const CTRL_O_TO_EXPAND = "(ctrl+o to expand)";

/** Tools that render their result through the reference's shell messages:
 *  a live progress block while they run (ShellProgressMessage) and a
 *  "(No output)" line when a finished command printed nothing
 *  (BashToolResultMessage). */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** What BashTool/PowerShellTool settle on when a command printed nothing
 *  (`settle(text || "(no output)")`, BashTool.ts). The reference's Bash result
 *  is structured — {stdout, stderr} — and BashToolResultMessage draws its own
 *  dim "(No output)" line when both are empty, so a silent command never
 *  reaches it as text. Ours arrives as this placeholder, which the renderer
 *  recognises and swaps for the reference's line. */
const NO_OUTPUT_SENTINEL = "(no output)";

/** A shell result carrying no output at all: an empty string, or the tool's
 *  own "(no output)" placeholder. */
function isSilentShellResult(toolName: string, outputText: string): boolean {
  if (!SHELL_TOOLS.has(toolName)) return false;
  return outputText === "" || outputText.trim() === NO_OUTPUT_SENTINEL;
}

function BlinkingDot({ color }: { color: string }): React.ReactElement {
  const show = useBlink();
  return <Text color={color}>{show ? `${BLACK_CIRCLE} ` : "  "}</Text>;
}

function StatusIcon({ status, color }: { status: "running" | "done" | "error"; color: string }): React.ReactElement {
  if (status === "running") return <BlinkingDot color={color} />;
  return (
    <Text color={color}>
      {BLACK_CIRCLE}{" "}
    </Text>
  );
}

const TOOL_LABELS: Record<string, string> = {
  Read: "Read",
  Write: "Write",
  // FileEditTool/UI.tsx userFacingName: "Update" (the use row above says
  // "Create" instead when old_string is empty — see toolLabel).
  Edit: "Update",
  Bash: "Bash",
  // GlobTool/UI.tsx and GrepTool/GrepTool.ts both return "Search"; the two
  // tools share one verb in the reference's transcript.
  Glob: "Search",
  Grep: "Search",
  LS: "LS",
  WebFetch: "WebFetch",
  WebSearch: "WebSearch",
  NotebookEdit: "NotebookEdit",
  Agent: "Agent",
  AskUserQuestion: "AskUser",
  EnterPlanMode: "PlanMode",
  ExitPlanMode: "ExitPlanMode",
  TodoWrite: "TodoWrite",
  TaskCreate: "TaskCreate",
  TaskGet: "TaskGet",
  TaskUpdate: "TaskUpdate",
  TaskList: "TaskList",
};

/** The tool's userFacingName: static for most tools, per-input for Edit
 *  (FileEditTool/UI.tsx: "Create" when the edit starts from an empty
 *  old_string, "Update" otherwise). */
export function toolLabel(toolName: string, input: unknown): string {
  if (toolName === "Edit") {
    return parseInput(input)?.["old_string"] === "" ? "Create" : "Update";
  }
  return TOOL_LABELS[toolName] || toolName;
}

function parseInput(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  if (input && typeof input === "object") return input as Record<string, unknown>;
  return undefined;
}

/** ShellTimeDisplay's clock — the reference's
 *  `formatDuration(elapsedSeconds * 1000)`: whole seconds under a minute,
 *  then minutes and seconds. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${rest}s`;
}

function truncateArg(input: string, maxLen = 60): string {
  const s = input.replace(/\n/g, " ").trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

/** BashTool/UI.tsx renderToolUseMessage: truncate by lines first (2), then by
 *  characters (160), and only then append "…". The reference returns the
 *  command itself when it fits, and `join('\n')` when it does not, so its Text
 *  draws the surviving line breaks — a two-line command stays two lines. */
function bashSubject(command: string): string {
  const lines = command.split("\n");
  const needsLineTruncation = lines.length > MAX_COMMAND_DISPLAY_LINES;
  const needsCharTruncation = command.length > MAX_COMMAND_DISPLAY_CHARS;
  if (!needsLineTruncation && !needsCharTruncation) return command;
  let truncated = needsLineTruncation ? lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join("\n") : command;
  if (truncated.length > MAX_COMMAND_DISPLAY_CHARS) truncated = truncated.slice(0, MAX_COMMAND_DISPLAY_CHARS);
  return truncated.trim() + "…";
}

function relPath(p: string): string {
  if (!p) return "";
  const cwd = process.cwd();
  if (cwd && (p.startsWith(cwd + "/") || p === cwd)) return p.slice(cwd.length + 1) || ".";
  return p;
}

/** The parenthesised subject of the tool-use line (the tool's own
 *  renderToolUseMessage, in the reference's wording). */
export function formatToolArgs(toolName: string, input: unknown): string {
  let obj: Record<string, unknown> | undefined;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input) as Record<string, unknown>;
    } catch {
      return truncateArg(input);
    }
  } else if (input && typeof input === "object") {
    obj = input as Record<string, unknown>;
  }
  if (!obj) return "";
  const str = (v: unknown, max = 70): string => truncateArg(typeof v === "string" ? v : String(v ?? ""), max);
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return relPath(String(obj["file_path"] ?? obj["notebook_path"] ?? ""));
    case "Bash":
      return bashSubject(String(obj["command"] ?? ""));
    case "Glob":
    case "Grep": {
      // GlobTool/UI.tsx and GrepTool/UI.tsx render `pattern: "…"` and add
      // `path: "…"` only when the call carried one.
      const raw = obj["pattern"];
      if (raw === undefined || raw === null || raw === "") return "";
      const pattern = typeof raw === "string" ? raw : String(raw);
      const path = typeof obj["path"] === "string" ? obj["path"] : "";
      return path
        ? `pattern: "${pattern}", path: "${relPath(path)}"`
        : `pattern: "${pattern}"`;
    }
    case "LS":
      return relPath(String(obj["path"] ?? ".")) || ".";
    case "WebFetch":
      return str(obj["url"]);
    case "WebSearch":
      return str(obj["query"]);
    case "TodoWrite":
      return Array.isArray(obj["todos"]) ? `${obj["todos"].length} todos` : "";
    case "Agent":
    case "Task":
      return str(obj["description"], 50);
    default: {
      const firstVal = Object.values(obj)[0];
      return firstVal ? str(firstVal) : "";
    }
  }
}

/** Line count of a body of text: a trailing newline is a terminator, not an
 *  extra empty line (FileWriteTool/UI.tsx countLines). */
function countContentLines(text: string): number {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed ? trimmed.split("\n").length : 0;
}

function countDiffLines(hunks: StructuredPatchHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

/** FileEditToolUpdatedMessage's stats line: "Added N lines, removed M lines",
 *  numbers bold, "Removed" capitalised only when there are no additions. */
function diffStatsRuns(added: number, removed: number): StyledRun[] {
  const runs: StyledRun[] = [];
  if (added > 0) {
    runs.push({ text: "Added " });
    runs.push({ text: String(added), style: { bold: true } });
    runs.push({ text: ` line${added > 1 ? "s" : ""}` });
  }
  if (added > 0 && removed > 0) runs.push({ text: ", " });
  if (removed > 0) {
    runs.push({ text: `${added === 0 ? "R" : "r"}emoved ` });
    runs.push({ text: String(removed), style: { bold: true } });
    runs.push({ text: ` line${removed > 1 ? "s" : ""}` });
  }
  return runs;
}

/** FallbackToolUseErrorMessage: unwrap the tool_use_error tag, drop <error>
 *  tags, then label the text "Error: …" unless it already carries a label. */
export function errorBodyText(output: string): string {
  const tagged = /<tool_use_error>([\s\S]*?)<\/tool_use_error>/.exec(output);
  const withoutTags = (tagged ? tagged[1]! : output).replace(/<\/?error>/g, "");
  const trimmed = withoutTags.trim();
  if (trimmed.startsWith("Error: ") || trimmed.startsWith("Cancelled: ")) return trimmed;
  return `Error: ${trimmed}`;
}

/** The result body under the ⎿ hook for a rejected or interrupted tool use.
 *  An interrupted call is always the dim "Interrupted · What should Claude
 *  do instead?" line (UserToolCanceledMessage / FallbackToolUseRejected-
 *  Message → InterruptedByUser). A rejection the engine reported as an error
 *  (our `{"error":"permission_denied"}` status) is RejectedToolUseMessage —
 *  "Tool use rejected" — except for the tools that ship their own rejected
 *  message (Edit, NotebookEdit). */
export function rejectionRuns(block: ToolUseBlock, theme: Theme): StyledRun[] {
  const subtle = resolveColor(theme.subtle);
  const input = parseInput(block.input);
  const filePath = String(input?.["file_path"] ?? input?.["notebook_path"] ?? "");
  const path = relPath(filePath);
  if (block.status !== "interrupted" && block.toolName === "Edit" && path) {
    // FileEditToolUseRejectedMessage: "User rejected update to <path>"
    // ("write" when the edit creates the file).
    const operation = input?.["old_string"] === "" ? "write" : "update";
    return [
      { text: `User rejected ${operation} to `, style: { color: subtle } },
      { text: path, style: { bold: true, color: subtle } },
    ];
  }
  if (block.status !== "interrupted" && block.toolName === "NotebookEdit" && path) {
    const editMode = typeof input?.["edit_mode"] === "string" ? input["edit_mode"] : "replace";
    const operation = editMode === "delete" ? "delete" : `${editMode} cell in`;
    const runs: StyledRun[] = [
      { text: `User rejected ${operation} `, style: { color: subtle } },
      { text: path, style: { bold: true, color: subtle } },
    ];
    const cell = input?.["cell_number"] ?? input?.["cell_id"];
    if (cell !== undefined && cell !== null) {
      runs.push({ text: ` at cell ${String(cell)}`, style: { color: subtle } });
    }
    return runs;
  }
  if (block.status === "rejected") {
    return [{ text: "Tool use rejected", style: { dim: true } }];
  }
  return [{ text: "Interrupted · What should Claude do instead?", style: { dim: true } }];
}

/** renderTruncatedContent (utils/terminal.ts): keep the first 3 rendered
 *  lines (4 when exactly one line would be left over), then a dim
 *  "… +N lines (ctrl+o to expand)" marker. */
function foldedRows(text: string, width: number): TextRow[] {
  const trimmed = text.trimEnd();
  if (!trimmed) return [];
  const source = trimmed.split("\n").map((l) => l.trimEnd()).join("\n");
  const wrapped = wrapTextRuns([{ text: source }], width);
  const remaining = wrapped.length - MAX_LINES_TO_SHOW;
  if (remaining <= 1) return wrapped;
  const kept = wrapped.slice(0, MAX_LINES_TO_SHOW);
  kept.push(...wrapTextRuns([{ text: `… +${remaining} lines ${CTRL_O_TO_EXPAND}`, style: { dim: true } }], width));
  return kept;
}

/** The collapsed (ctrl+o-collapsed) summary line(s) of a finished tool. Each
 *  tool keeps the reference's own result wording; tools without one fold
 *  their output at 3 lines like renderTruncatedContent. */
function summaryRows(
  block: ToolUseBlock,
  outputText: string,
  hunks: StructuredPatchHunk[],
  width: number,
  theme: Theme,
): TextRow[] {
  const hint: StyledRun = { text: ` ${CTRL_O_TO_EXPAND}`, style: { dim: true } };
  const input = parseInput(block.input);
  const path = relPath(String(input?.["file_path"] ?? input?.["notebook_path"] ?? ""));
  switch (block.toolName) {
    case "Read": {
      // FileReadTool/UI.tsx renderToolResultMessage (text): "Read N lines".
      const n = countContentLines(outputText);
      return wrapTextRuns(
        [
          { text: "Read " },
          { text: String(n), style: { bold: true } },
          { text: ` ${n === 1 ? "line" : "lines"}` },
          hint,
        ],
        width,
      );
    }
    case "Write": {
      const { added, removed } = countDiffLines(hunks);
      const stats = diffStatsRuns(added, removed);
      if (stats.length > 0) return wrapTextRuns([...stats, hint], width);
      // FileWriteToolCreatedMessage: "Wrote N lines to <path>".
      const content = typeof input?.["content"] === "string" ? input["content"] : "";
      const n = countContentLines(content || outputText);
      const runs: StyledRun[] = [{ text: "Wrote " }, { text: String(n), style: { bold: true } }, { text: " lines" }];
      if (path) runs.push({ text: " to " }, { text: path, style: { bold: true } });
      runs.push(hint);
      return wrapTextRuns(runs, width);
    }
    case "Edit": {
      // FileEditToolUpdatedMessage's stats line.
      const { added, removed } = countDiffLines(hunks);
      const stats = diffStatsRuns(added, removed);
      if (stats.length > 0) return wrapTextRuns([...stats, hint], width);
      break;
    }
    case "NotebookEdit": {
      // NotebookEditTool/UI.tsx renderToolResultMessage: "Updated cell N:".
      const cell = input?.["cell_number"] ?? input?.["cell_id"];
      if (cell !== undefined && cell !== null && cell !== "") {
        return wrapTextRuns(
          [{ text: "Updated cell " }, { text: String(cell), style: { bold: true } }, { text: ":" }, hint],
          width,
        );
      }
      break;
    }
  }
  return foldedRows(outputText, width);
}

/** One model span of a tool block: selectable rows at a known column
 *  origin. MessageView owns the model (buildToolBlockSpans) so the row
 *  accumulator and the rendered rows can never drift; ToolBlock renders
 *  exactly these spans. */
export interface ToolBlockSpan {
  key: string;
  rowCount: number;
  /** Content model rows (copy/highlight). Diff rows carry the content
   *  runs only — the gutter lives outside the model. */
  rows: TextRow[];
  /** Column where the span's content starts (within the content area). */
  leftOffset: number;
  /** Width of the content area (selection column math). */
  width: number;
  kind: "text" | "plain" | "opaque";
  /** When set, rows render via DiffRow (gutter + diff background). */
  diff?: DiffRowModel[];
}

/** Build the selectable model spans for a tool block. The head row is NOT
 *  part of this list — MessageView reports it separately (always 1 row). */
export function buildToolBlockSpans(
  block: ToolUseBlock,
  contentWidth: number,
  isTranscriptMode: boolean,
  theme: Theme,
): ToolBlockSpan[] {
  const spans: ToolBlockSpan[] = [];
  const width = Math.max(1, contentWidth - TOOL_OUT_LEFT);
  const expanded = block.isExpanded || isTranscriptMode;
  // Render-time secret masking — the model still sees the raw output; only
  // the screen redacts API keys (Claude Code parity).
  const outputText = redactSecrets(block.output || "");
  const pushRows = (key: string, rows: TextRow[]) => {
    spans.push({ key, rowCount: rows.length, rows, leftOffset: TOOL_OUT_LEFT, width, kind: "text" });
  };
  const pushTextSpan = (key: string, runs: StyledRun[]) => {
    pushRows(key, wrapTextRuns(runs, width));
  };

  // Rejected / interrupted: the reference's rejection body under the ⎿ hook
  // (the tool's own message, or the Interrupted line) — never a ✗ row that
  // repeats the tool name and an internal status word.
  if (block.status === "rejected" || block.status === "interrupted") {
    pushTextSpan("rejected", rejectionRuns(block, theme));
    return spans;
  }

  // Running: ShellProgressMessage — the last 5 lines of live output (dim)
  // plus the "+N lines" status row, or "Running… " with none yet. The
  // elapsed clock is appended to the status row by the renderer (it ticks
  // without the span model changing).
  if (block.status === "running") {
    const lines = outputText.split("\n").filter((line) => line !== "");
    if (lines.length === 0) {
      if (SHELL_TOOLS.has(block.toolName)) {
        pushTextSpan("progress", [{ text: "Running… ", style: { dim: true } }]);
      }
      return spans;
    }
    const shown = expanded ? lines : lines.slice(-MAX_PROGRESS_LINES);
    pushTextSpan("progress", [{ text: shown.join("\n"), style: { dim: true } }]);
    const extra = expanded ? 0 : Math.max(0, lines.length - MAX_PROGRESS_LINES);
    pushTextSpan("progress-status", [{ text: extra > 0 ? `+${extra} lines` : "", style: { dim: true } }]);
    return spans;
  }

  const isDiffTool = block.toolName === "Edit" || block.toolName === "Write";
  const hunks = isDiffTool && outputText ? parseDiffTextToHunks(outputText) : [];

  // Failed tool: FallbackToolUseErrorMessage — "Error: <trimmed output>" in
  // the error colour, the first 10 lines, then the "to see all" fold.
  if (block.status === "error") {
    const allLines = errorBodyText(outputText).split("\n");
    const shown = expanded ? allLines : allLines.slice(0, MAX_ERROR_RENDERED_LINES);
    pushTextSpan("error", [{ text: shown.join("\n"), style: { color: resolveColor(theme.error) } }]);
    if (!expanded && allLines.length > MAX_ERROR_RENDERED_LINES) {
      const plus = allLines.length - MAX_ERROR_RENDERED_LINES;
      pushTextSpan("error-truncated", [
        { text: `… +${plus} ${plus === 1 ? "line" : "lines"} (ctrl+o to see all)`, style: { dim: true } },
      ]);
    }
    return spans;
  }

  // A finished shell command that printed nothing still says so
  // (BashToolResultMessage: "(No output)"). Checked before the expanded body
  // because the reference draws this line in both views — it hangs on stdout
  // and stderr being empty, not on the fold.
  if (block.status === "done" && isSilentShellResult(block.toolName, outputText)) {
    pushTextSpan("no-output", [{ text: "(No output)", style: { dim: true } }]);
    return spans;
  }

  if (outputText && expanded) {
    if (hunks.length > 0) {
      // Stats line ("Added N lines, Removed M lines", bold numbers — the
      // reference renders it as the first row of the result body, above the
      // diff). The file itself is already named on the head row above, so
      // the tool result's own "Edited <path>" line is not repeated here.
      const { added, removed } = countDiffLines(hunks);
      const statsRuns = diffStatsRuns(added, removed);
      if (statsRuns.length > 0) pushTextSpan("stats", statsRuns);

      // Every hunk of the patch, "..." separators between them
      // (FileEditToolUpdatedMessage → StructuredDiffList has no row cap).
      hunks.forEach((hunk, hi) => {
        if (hi > 0) {
          pushTextSpan(`sep-${hi}`, [{ text: "...", style: { dim: true } }]);
        }
        const model = buildDiffModel(hunk.lines, hunk.oldStart, width, false, theme);
        const gutterWidth = model.length > 0 ? stringWidth(model[0]!.gutter) : 0;
        const spanWidth = Math.max(1, width - gutterWidth);
        spans.push({
          key: `diff-${hi}`,
          rowCount: model.length,
          rows: model.map((r) => ({ runs: r.runs, softWrapped: false })),
          leftOffset: TOOL_OUT_LEFT + gutterWidth,
          width: spanWidth,
          kind: "text",
          diff: model,
        });
      });
      return spans;
    }

    // Raw output: one wrapped Text per source line; +/- first tokens
    // colored like diff markers, everything else in the default foreground
    // (OutputLine sets no colour for stdout).
    const rows: TextRow[] = [];
    for (const line of outputText.split("\n")) {
      let style: StyledRun["style"] | undefined;
      const trimmed = line.trimStart();
      if (trimmed.startsWith("+")) style = { color: resolveColor(theme.diffAddedWord) };
      else if (trimmed.startsWith("-")) style = { color: resolveColor(theme.diffRemovedWord) };
      rows.push(...wrapLineRuns([{ text: line, style }], width));
    }
    pushRows("raw", rows);
    return spans;
  }

  // Collapsed summary line (done tools).
  if (block.status === "done" && outputText) {
    pushRows("summary", summaryRows(block, outputText, hunks, width, theme));
  }

  return spans;
}

interface ToolBlockProps {
  block: ToolUseBlock;
  /** Model spans (MessageView owns them; renders exactly these rows). */
  spans: ToolBlockSpan[];
  isHighlighted?: boolean;
  /** Active selection (content coords) or null. */
  selection?: ContentSelection | null;
  /** Content row where the block's content area begins (below the head). */
  startRow: number;
  contentWidth: number;
  theme: Theme;
  /** Registers the head row with MessageView's opaque-span registry, so a
   *  head of more than one row (a multi-line shell subject) is measured
   *  rather than assumed. */
  headRef?: (el: DOMElement | null) => void;
}

function ToolBlock({
  block,
  spans,
  isHighlighted,
  selection = null,
  startRow,
  contentWidth,
  theme,
  headRef,
}: ToolBlockProps) {
  const label = toolLabel(block.toolName, block.input);
  const argPreviewRaw = formatToolArgs(block.toolName, block.input);
  const argPreview = argPreviewRaw ? `(${argPreviewRaw})` : "";

  const isRunning = block.status === "running";
  const isDone = block.status === "done";
  const isRejected = block.status === "rejected" || block.status === "interrupted";
  // ShellProgressMessage's clock, appended to the running status row. The
  // reference gets its elapsed seconds from the engine's progress events.
  const elapsedSeconds = useElapsedSeconds(isRunning);

  // ToolUseLoader: an unresolved call has no colour, an errored one is
  // 'error', a resolved one 'success' — a rejected call counts as resolved.
  const statusColor = isRunning
    ? resolveColor(theme.inactive)
    : isDone || isRejected
      ? resolveColor(theme.success)
      : resolveColor(theme.error);

  // The clock rides the block's last body row: ShellProgressMessage's status
  // row when there is live output, the "Running… " row when there is not.
  const clockKey = isRunning
    ? spans.some((span) => span.key === "progress-status")
      ? "progress-status"
      : "progress"
    : null;

  // Content spans at exact model rows. Each rendered row is one model row
  // (Box height=1), so the screen always matches the selection model.
  const fragments: React.ReactNode[] = [];
  let acc = 0;
  for (const span of spans) {
    for (let i = 0; i < span.rowCount; i++) {
      const sel = rowSelection(selection, startRow + acc + i, span.leftOffset, contentWidth);
      const key = `${span.key}-${i}`;
      if (span.diff && span.diff[i]) {
        fragments.push(
          <Box key={key} height={1} flexShrink={0} minWidth={0}>
            <DiffRow row={span.diff[i]!} dim={false} theme={theme} contentWidth={span.width} selCols={sel} />
          </Box>,
        );
        continue;
      }
      // The live clock is not part of the model (it ticks without the spans
      // being rebuilt), so it is appended here — the row count is unchanged
      // either way.
      const withClock =
        clockKey !== null && span.key === clockKey && i === span.rowCount - 1 && elapsedSeconds !== undefined;
      if (withClock) {
        const row = span.rows[i]!;
        const text = row.runs.map((r) => r.text).join("");
        // "Running… " already ends in the reference's space; "+N lines" needs
        // one before the clock (ShellProgressMessage's row gap).
        const separator = text === "" || /\s$/.test(text) ? "" : " ";
        fragments.push(
          <Box key={key} height={1} flexShrink={0} minWidth={0}>
            {text !== "" && <RowText row={row} selCols={sel} rowWidth={span.width} />}
            <Text dimColor wrap="truncate-end">{`${separator}(${formatElapsed(elapsedSeconds)})`}</Text>
          </Box>,
        );
        continue;
      }
      fragments.push(
        <Box key={key} height={1} flexShrink={0} minWidth={0}>
          <RowText row={span.rows[i]!} selCols={sel} rowWidth={span.width} />
        </Box>,
      );
    }
    acc += span.rowCount;
  }

  return (
    <Box flexDirection="column" marginY={0}>
      {/* Head — one row per line of the subject (a shell command keeps the
          line breaks the reference's Text draws); every other text is
          single-line via truncate-end. */}
      <Box ref={headRef} flexDirection="row">
        {isHighlighted && <Text color={theme.warning} bold>▶ </Text>}
        <StatusIcon status={isRunning ? "running" : "done"} color={statusColor} />
        <Box flexShrink={0}>
          <Text bold wrap="truncate-end">
            {label}
          </Text>
        </Box>
        {argPreviewRaw && (
          <Box flexShrink={1} flexWrap="nowrap" minWidth={0}>
            <Text wrap="truncate-end">{argPreview}</Text>
          </Box>
        )}
        {/* No elapsed time on the head row: AssistantToolUseMessage's head is
            dot + name + (args) + tool tag, and nothing else. */}
        {isHighlighted && (
          <Text color={theme.warning} bold> [Space to toggle]</Text>
        )}
      </Box>

      {fragments.length > 0 && (
        <Box flexDirection="row" flexShrink={0} minWidth={0}>
          {/* MessageResponse's "  ⎿  " prefix, so every result body starts
              at column 5 with the hook at column 2. */}
          <Box flexShrink={0}>
            <Text dimColor>{TOOL_RESULT_PREFIX}</Text>
          </Box>
          <Box flexDirection="column" flexShrink={1} minWidth={0}>
            {fragments}
          </Box>
        </Box>
      )}
    </Box>
  );
}

export default React.memo(ToolBlock);
