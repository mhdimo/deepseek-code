import React, { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import type { ToolUseBlock } from "../types/index.js";
import { resolveColor, type Theme } from "../utils/theme.js";
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

export const BLACK_CIRCLE = "●";

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
  Edit: "Edit",
  Bash: "Bash",
  Glob: "Glob",
  Grep: "Grep",
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncateArg(input: string, maxLen = 60): string {
  const s = input.replace(/\n/g, " ").trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

function relPath(p: string): string {
  if (!p) return "";
  const cwd = process.cwd();
  if (cwd && (p.startsWith(cwd + "/") || p === cwd)) return p.slice(cwd.length + 1) || ".";
  return p;
}

function formatToolArgs(toolName: string, input: unknown): string {
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
      return str(obj["command"], 90);
    case "Glob":
      return str(obj["pattern"]);
    case "Grep":
      return str(obj["pattern"]);
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

/** Column where the tool's output area begins (its marginLeft). */
export const TOOL_OUT_LEFT = 3;

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
  if (block.status === "rejected" || block.status === "interrupted") return [];
  const spans: ToolBlockSpan[] = [];
  const width = Math.max(1, contentWidth - TOOL_OUT_LEFT);
  const expanded = block.isExpanded || isTranscriptMode;
  const isError = block.status === "error";
  const outputText = block.output || "";

  if (outputText && (expanded || isError)) {
    const maxOutputLines = isError && !expanded ? 12 : expanded ? (isTranscriptMode ? 1000 : 200) : 0;
    const isDiffTool = block.toolName === "Edit" || block.toolName === "Write";
    const hunks = isDiffTool ? parseDiffTextToHunks(outputText) : [];
    const pushTextSpan = (key: string, runs: StyledRun[]) => {
      const rows = wrapTextRuns(runs, width);
      spans.push({ key, rowCount: rows.length, rows, leftOffset: TOOL_OUT_LEFT, width, kind: "text" });
    };

    if (hunks.length > 0) {
      // Header = the first non-empty line before the first hunk (the tool
      // result's "Edited src/foo.ts" line), dim like a result summary.
      const firstAt = outputText.indexOf("@@");
      const header = firstAt === -1 ? "" : outputText.slice(0, firstAt).trim().split("\n")[0] ?? "";
      if (header) {
        pushTextSpan("header", [{ text: header, style: { dim: true } }]);
      }

      // Stats line ("Added N lines, Removed M lines", bold numbers — the
      // reference renders it above the diff, normal color).
      let added = 0;
      let removed = 0;
      for (const h of hunks) {
        for (const l of h.lines) {
          if (l.startsWith("+")) added++;
          else if (l.startsWith("-")) removed++;
        }
      }
      if (added > 0 || removed > 0) {
        const statsRuns: StyledRun[] = [];
        if (added > 0) {
          statsRuns.push({ text: "Added " });
          statsRuns.push({ text: String(added), style: { bold: true } });
          statsRuns.push({ text: ` line${added > 1 ? "s" : ""}` });
        }
        if (added > 0 && removed > 0) statsRuns.push({ text: ", " });
        if (removed > 0) {
          statsRuns.push({ text: `${added === 0 ? "R" : "r"}emoved ` });
          statsRuns.push({ text: String(removed), style: { bold: true } });
          statsRuns.push({ text: ` line${removed > 1 ? "s" : ""}` });
        }
        pushTextSpan("stats", statsRuns);
      }

      // Diff rows per hunk, truncated to the output budget, with "…"
      // separators between hunks (StructuredDiffList semantics).
      let budget = maxOutputLines;
      let dropped = 0;
      hunks.forEach((hunk, hi) => {
        if (budget <= 0) {
          dropped += hunk.lines.length;
          return;
        }
        if (hi > 0) {
          const sepRows = wrapTextRuns([{ text: "...", style: { dim: true } }], width);
          spans.push({ key: `sep-${hi}`, rowCount: sepRows.length, rows: sepRows, leftOffset: TOOL_OUT_LEFT, width, kind: "text" });
        }
        const take = Math.min(hunk.lines.length, budget);
        const kept = { ...hunk, lines: hunk.lines.slice(0, take) };
        const model = buildDiffModel(kept.lines, kept.oldStart, width, false, theme);
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
        budget -= take;
        dropped += hunk.lines.length - take;
      });

      if (dropped > 0) {
        pushTextSpan("truncated", [{ text: `… (${dropped} more lines)`, style: { dim: true } }]);
      }
    } else {
      // Raw output: one wrapped Text per source line; error lines red,
      // +/- first tokens colored like diff markers, the rest dim.
      const allLines = outputText.split("\n");
      const showLines = allLines.slice(0, maxOutputLines);
      const rows: TextRow[] = [];
      for (const line of showLines) {
        let style: StyledRun["style"] = { dim: true };
        if (isError) {
          style = { color: resolveColor(theme.error) };
        } else {
          const trimmed = line.trimStart();
          if (trimmed.startsWith("+")) style = { color: resolveColor(theme.diffAddedWord) };
          else if (trimmed.startsWith("-")) style = { color: resolveColor(theme.diffRemovedWord) };
        }
        rows.push(...wrapLineRuns([{ text: line, style }], width));
      }
      spans.push({ key: "raw", rowCount: rows.length, rows, leftOffset: TOOL_OUT_LEFT, width, kind: "text" });
      if (allLines.length > maxOutputLines) {
        pushTextSpan("truncated", [{ text: `… (${allLines.length - maxOutputLines} more lines)`, style: { dim: true } }]);
      }
    }
  }

  // Collapsed summary line (done tools).
  if (block.status === "done" && outputText && !expanded) {
    const outputLines = outputText.trim() ? outputText.replace(/\n+$/, "").split("\n").length : 0;
    let text: string;
    if (["Read", "Write", "Edit", "NotebookEdit"].includes(block.toolName)) {
      text = `${outputLines > 0 ? `${outputLines} line${outputLines === 1 ? "" : "s"}` : "done"} (ctrl+o to expand)`;
    } else {
      const firstLines = outputText.trim().split("\n").slice(0, 4).join("\n");
      text = outputLines > 4 ? `${firstLines}\n  ... (+${outputLines - 4} lines, ctrl+o to expand)` : firstLines;
    }
    const rows = wrapTextRuns([{ text, style: { dim: true } }], width);
    spans.push({ key: "summary", rowCount: rows.length, rows, leftOffset: TOOL_OUT_LEFT, width, kind: "text" });
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
  /** Content row where the block's content area begins (head + 1). */
  startRow: number;
  contentWidth: number;
  theme: Theme;
}

function ToolBlock({ block, spans, isHighlighted, selection = null, startRow, contentWidth, theme }: ToolBlockProps) {
  const label = TOOL_LABELS[block.toolName] || block.toolName;
  const argPreviewRaw = formatToolArgs(block.toolName, block.input);
  const argPreview = argPreviewRaw ? `(${argPreviewRaw})` : "";

  if (block.status === "rejected" || block.status === "interrupted") {
    return (
      <Box flexDirection="row" marginY={0}>
        {isHighlighted && <Text color={theme.warning} bold>▶ </Text>}
        <Text color="gray">✗ </Text>
        <Text color="gray" dimColor>
          {label}
          {argPreviewRaw ? ` (${argPreviewRaw})` : ""} [{block.status}]
        </Text>
      </Box>
    );
  }

  const isRunning = block.status === "running";
  const isDone = block.status === "done";
  const isError = block.status === "error";

  const statusColor = isRunning
    ? resolveColor(theme.inactive)
    : isDone
      ? resolveColor(theme.success)
      : resolveColor(theme.error);

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
      } else {
        fragments.push(
          <Box key={key} height={1} flexShrink={0} minWidth={0}>
            <RowText row={span.rows[i]!} selCols={sel} rowWidth={span.width} />
          </Box>,
        );
      }
    }
    acc += span.rowCount;
  }

  return (
    <Box flexDirection="column" marginY={0}>
      {/* Head — always exactly 1 row (all texts truncate-end). */}
      <Box flexDirection="row">
        {isHighlighted && <Text color={theme.warning} bold>▶ </Text>}
        <StatusIcon status={isRunning ? "running" : isDone ? "done" : "error"} color={statusColor} />
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
        {block.duration !== undefined && block.duration > 0 && (
          <Text dimColor wrap="truncate-end">
            {" "}({formatDuration(block.duration)})
          </Text>
        )}
        {isHighlighted && (
          <Text color={theme.warning} bold> [Space to toggle]</Text>
        )}
      </Box>

      {fragments.length > 0 && (
        <Box flexDirection="column" marginLeft={TOOL_OUT_LEFT} flexShrink={0} minWidth={0}>
          {fragments}
        </Box>
      )}
    </Box>
  );
}

export default React.memo(ToolBlock);
