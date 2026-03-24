// Tool use block display (matches Claude Code's collapsible tool blocks)

import React from "react";
import { Box, Text } from "ink";
import type { ToolUseBlock } from "../core/types.js";
import Spinner from "./Spinner.js";

const TOOL_COLORS: Record<string, string> = {
  Read: "cyan",
  Edit: "yellow",
  Write: "magenta",
  Bash: "green",
  Glob: "blue",
  Grep: "blue",
  LS: "gray",
};

interface ToolBlockProps {
  block: ToolUseBlock;
}

export default function ToolBlock({ block }: ToolBlockProps) {
  const color = TOOL_COLORS[block.toolName] || "gray";
  const isRunning = block.status === "running";
  const isError = block.status === "error";
  const isFileMutationTool = block.toolName === "Write" || block.toolName === "Edit";

  const inputDisplay = block.input || "";
  const shouldShowOutput = Boolean(block.output) && (block.isExpanded || isError || isFileMutationTool);

  const maxOutputChars = 3000;
  const outputDisplay = block.output
    ? (block.output.length > maxOutputChars
      ? `${block.output.slice(0, maxOutputChars)}\n... (truncated)`
      : block.output)
    : "";

  const outputLines = outputDisplay.split("\n");

  const lineColor = (line: string): string | undefined => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("+")) return "green";
    if (trimmed.startsWith("-")) return "red";
    if (trimmed.startsWith("@@") || trimmed === "Diff preview:" || trimmed === "Replacement preview:") {
      return "cyan";
    }
    return undefined;
  };

  return (
    <Box flexDirection="column" marginLeft={1} marginY={0}>
      <Box>
        {isRunning ? (
          <Text color={color} bold>⠿ </Text>
        ) : isError ? (
          <Text color="red" bold>✗ </Text>
        ) : (
          <Text color={color} bold>✓ </Text>
        )}
        <Text color={color} bold>
          {block.toolName}
        </Text>
        {inputDisplay && (
          <Text dimColor wrap="wrap"> {inputDisplay}</Text>
        )}
        {block.duration !== undefined && block.duration > 0 && (
          <Text dimColor> ({block.duration}ms)</Text>
        )}
      </Box>

      {/* Show output for completed blocks so users can see history details */}
      {shouldShowOutput && (
        <Box flexDirection="column" marginLeft={3} marginTop={0}>
          {outputLines.map((line, i) => {
            const c = lineColor(line);
            return (
              <Text
                key={`${block.toolCallId || block.toolName}-${i}`}
                color={isError ? "red" : c}
                dimColor={!isError && !c}
                wrap="wrap"
              >
                {line || " "}
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
