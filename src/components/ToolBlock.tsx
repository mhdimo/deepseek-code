import React, { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import type { ToolUseBlock } from "../types/index.js";
import { theme, resolveColor } from "../utils/theme.js";
import { StructuredDiff, parseDiffTextToHunk } from "./StructuredDiff.js";



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


export const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";






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

interface ToolBlockProps {
  block: ToolUseBlock;
  isHighlighted?: boolean;
  isTranscriptMode?: boolean;
}

function ToolBlock({ block, isHighlighted, isTranscriptMode }: ToolBlockProps) {
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
  const isError = block.status === "error";
  const isDone = block.status === "done";

  
  const statusColor = isRunning
    ? resolveColor(theme.inactive)
    : isDone
      ? resolveColor(theme.success)
      : resolveColor(theme.error);

  
  const expanded = block.isExpanded || isTranscriptMode;
  const maxOutputLines = expanded ? (isTranscriptMode ? 1000 : 200) : 12;
  const outputText = block.output || "";
  const allLines = outputText.split("\n");
  const showLines = allLines.slice(0, maxOutputLines);
  const truncated = allLines.length > maxOutputLines;
  const outputLines = outputText.trim() ? outputText.replace(/\n+$/, "").split("\n").length : 0;

  
  const lineColor = (line: string): string | undefined => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("+")) return resolveColor(theme.diffAddedWord);
    if (trimmed.startsWith("-")) return resolveColor(theme.diffRemovedWord);
    return undefined;
  };

  
  
  const cols = process.stdout.columns || 80;
  const diffWidth = Math.max(20, cols - 12);
  const isDiffTool = block.toolName === "Edit" || block.toolName === "Write";
  const hunk = isDiffTool && outputText ? parseDiffTextToHunk(outputText) : null;

  
  const diffStats = hunk ? (() => {
    let added = 0, removed = 0;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
    return { added, removed };
  })() : null;

  let headerText = "";
  let displayHunk = hunk;

  if (hunk && outputText) {
    const firstHunkLine = hunk.lines[0];
    if (firstHunkLine) {
      const idx = outputText.indexOf(firstHunkLine);
      if (idx !== -1) {
        headerText = outputText.slice(0, idx).trim();
      } else {
        headerText = outputText.split("\n")[0] || "";
      }
    }

    if (hunk.lines.length > maxOutputLines) {
      displayHunk = {
        ...hunk,
        lines: hunk.lines.slice(0, maxOutputLines),
      };
    }
  }

  return (
    <Box flexDirection="column" marginY={0}>
      {}
      <Box flexDirection="row">
        {isHighlighted && <Text color={theme.warning} bold>▶ </Text>}
        <StatusIcon status={isRunning ? "running" : isDone ? "done" : "error"} color={statusColor} />
        <Box flexShrink={0}>
          <Text bold wrap="truncate-end">
            {label}
          </Text>
        </Box>
        {argPreviewRaw && (
          <Box flexShrink={0} flexWrap="nowrap">
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

      {}
      {outputText && (expanded || isError) && (
        <Box flexDirection="column" marginLeft={3}>
          {displayHunk ? (
            <Box flexDirection="column">
              {headerText ? (
                <Box marginBottom={1}>
                  <Text dimColor>{headerText}</Text>
                </Box>
              ) : null}
              <Box
                borderStyle={{
                  top: "╌",
                  left: "╎",
                  right: "╎",
                  bottom: "╌",
                  topLeft: " ",
                  topRight: " ",
                  bottomLeft: " ",
                  bottomRight: " ",
                }}
                borderLeft={false}
                borderRight={false}
                borderTop={true}
                borderBottom={true}
                borderColor="gray"
                paddingX={1}
              >
                <StructuredDiff patch={displayHunk} width={diffWidth} />
              </Box>
              {diffStats && (diffStats.added > 0 || diffStats.removed > 0) && (
                <Box marginTop={1}>
                  <Text dimColor>
                    {diffStats.added > 0 && (
                      <Text>Added <Text bold>{diffStats.added}</Text> {diffStats.added === 1 ? "line" : "lines"}</Text>
                    )}
                    {diffStats.added > 0 && diffStats.removed > 0 && <Text>, </Text>}
                    {diffStats.removed > 0 && (
                      <Text>
                        {diffStats.added === 0 ? "R" : "r"}emoved <Text bold>{diffStats.removed}</Text> {diffStats.removed === 1 ? "line" : "lines"}
                      </Text>
                    )}
                  </Text>
                </Box>
              )}
            </Box>
          ) : (
            showLines.map((line, i) => {
              const c = lineColor(line);
              return (
                <Text
                  key={`${block.toolCallId}-out-${i}`}
                  color={isError ? resolveColor(theme.error) : c}
                  dimColor={!isError && !c}
                  wrap="wrap"
                >
                  {line || " "}
                </Text>
              );
            })
          )}
          {truncated && (
            <Text dimColor>
              … ({allLines.length - maxOutputLines} more lines)
            </Text>
          )}
        </Box>
      )}

      {}
      {isDone && outputText && !expanded && (
        <Box marginLeft={3}>
          {["Read", "Write", "Edit", "NotebookEdit"].includes(block.toolName) ? (
            <Text dimColor>
              {outputLines > 0 ? `${outputLines} line${outputLines === 1 ? "" : "s"}` : "done"}
              {" "}(ctrl+o to expand)
            </Text>
          ) : (
            <Text dimColor>
              {outputText.trim().split("\n").slice(0, 4).join("\n")}
              {outputLines > 4 ? `\n  ... (+${outputLines - 4} lines, ctrl+o to expand)` : ""}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

export default React.memo(ToolBlock);
