import React from "react";
import { Box, Text } from "ink";
import type { ToolUseBlock } from "../types/index.js";
import { theme } from "../utils/theme.js";

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
}

export default function ToolBlock({ block, isHighlighted }: ToolBlockProps) {
  const label = TOOL_LABELS[block.toolName] || block.toolName;
  const labelColor = theme.toolLabel[block.toolName] || theme.inactive;
  const isRunning = block.status === "running";
  const isError = block.status === "error";
  const isDone = block.status === "done";

  // Status icon — ⏺ for running matching Claude Code, ✓/✗ for done/error
  const statusIcon = isRunning ? BLACK_CIRCLE : isDone ? "✓" : "✗";
  const statusColor = isRunning ? theme.assistant : isDone ? theme.success : theme.error;

  // Build argument preview
  const argPreview = block.input ? ` ${truncateArg(block.input)}` : "";

  // Output lines
  const maxOutputLines = block.isExpanded ? 200 : 12;
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

  return (
    <Box flexDirection="column" marginY={0}>
      {/* Header: status + tool label badge + args + duration */}
      <Box>
        {isHighlighted && <Text color={theme.warning} bold>▶ </Text>}
        <Text color={statusColor}>{statusIcon} </Text>
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
      {outputText && (block.isExpanded || isError) && (
        <Box flexDirection="column" marginLeft={3}>
          {showLines.map((line, i) => {
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
          })}
          {truncated && (
            <Text dimColor>
              … ({allLines.length - maxOutputLines} more lines)
            </Text>
          )}
        </Box>
      )}

      {/* Result summary for done blocks */}
      {isDone && outputText && !block.isExpanded && (
        <Box marginLeft={3}>
          <Text dimColor>
            {outputText.length > 120
              ? outputText.slice(0, 119) + "…"
              : outputText}
          </Text>
        </Box>
      )}
    </Box>
  );
}
