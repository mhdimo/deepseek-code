import React, { useSyncExternalStore } from "react";
import { Box, Text } from "ink";
import type { ToolUseBlock } from "../types/index.js";
import { theme } from "../utils/theme.js";
import { StructuredDiff, parseDiffTextToHunk } from "./StructuredDiff.js";

// Shared blink store
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

// Blinking dot — only mounted for RUNNING tools. Done/error blocks render a
// static glyph instead, so committed tool blocks never subscribe to the blink
// ticker and don't re-render every 400ms (a major flicker source).
function BlinkingDot({ color }: { color: string }): React.ReactElement {
  const show = useBlink();
  return <Text color={color}>{show ? "⏺ " : "  "}</Text>;
}

function StatusIcon({ status, color }: { status: "running" | "done" | "error"; color: string }): React.ReactElement {
  if (status === "running") return <BlinkingDot color={color} />;
  return (
    <Text color={color}>
      {status === "done" ? "✓" : "✗"}
      {" "}
    </Text>
  );
}

// Tool label display names
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

const BLACK_CIRCLE = "⏺";

interface ToolBlockProps {
  block: ToolUseBlock;
  isHighlighted?: boolean;
  isTranscriptMode?: boolean;
}

function ToolBlock({ block, isHighlighted, isTranscriptMode }: ToolBlockProps) {
  const label = TOOL_LABELS[block.toolName] || block.toolName;
  const argPreview = block.input ? ` ${truncateArg(block.input)}` : "";

  if (block.status === "rejected" || block.status === "interrupted") {
    return (
      <Box flexDirection="row" marginY={0}>
        {isHighlighted && <Text color={theme.warning} bold>▶ </Text>}
        <Text color="gray">✗ </Text>
        <Text color="gray" dimColor>
          {label}{argPreview} [{block.status}]
        </Text>
      </Box>
    );
  }

  const labelColor = theme.toolLabel[block.toolName] || theme.inactive;
  const isRunning = block.status === "running";
  const isError = block.status === "error";
  const isDone = block.status === "done";

  const statusColor = isRunning ? theme.assistant : isDone ? theme.success : theme.error;

  // Output lines
  const expanded = block.isExpanded || isTranscriptMode;
  const maxOutputLines = expanded ? (isTranscriptMode ? 1000 : 200) : 12;
  const outputText = block.output || "";
  const allLines = outputText.split("\n");
  const showLines = allLines.slice(0, maxOutputLines);
  const truncated = allLines.length > maxOutputLines;

  // Line color for diff-style output
  const lineColor = (line: string): string | undefined => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("+")) return theme.diffAddedText;
    if (trimmed.startsWith("-")) return theme.diffRemovedText;
    return undefined;
  };

  // Structured Diff support
  const cols = process.stdout.columns || 80;
  const diffWidth = Math.max(20, cols - 6);
  const isDiffTool = block.toolName === "Edit" || block.toolName === "Write";
  const hunk = isDiffTool && outputText ? parseDiffTextToHunk(outputText) : null;

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
      {/* Header: status + tool label badge + args + duration */}
      <Box>
        {isHighlighted && <Text color={theme.warning} bold>▶ </Text>}
        <StatusIcon status={isRunning ? "running" : isDone ? "done" : "error"} color={statusColor} />
        <Text backgroundColor={labelColor} color={theme.inverseText} bold>
          {" "}{label}{" "}
        </Text>
        <Text dimColor>{argPreview}</Text>
        {block.duration !== undefined && block.duration > 0 && (
          <Text dimColor> ({formatDuration(block.duration)})</Text>
        )}
        {isHighlighted && (
          <Text color={theme.warning} bold> [Space to toggle]</Text>
        )}
      </Box>

      {/* Output preview */}
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
            </Box>
          ) : (
            showLines.map((line, i) => {
              const c = lineColor(line);
              return (
                <Text
                  key={`${block.toolCallId}-out-${i}`}
                  color={isError ? theme.error : c}
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

      {/* Result summary for done blocks */}
      {isDone && outputText && !expanded && (
        <Box marginLeft={3}>
          <Text dimColor>
            {outputText.length > 120
              ? outputText.slice(0, 119) + "…"
              : outputText}
            {" "}(ctrl+o to expand)
          </Text>
        </Box>
      )}
    </Box>
  );
}

export default React.memo(ToolBlock);
