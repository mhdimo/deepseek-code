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

  // Format the input for display
  const inputDisplay = block.input
    ? block.input.length > 80
      ? block.input.slice(0, 77) + "..."
      : block.input
    : "";

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
          <Text dimColor> {inputDisplay}</Text>
        )}
        {block.duration !== undefined && block.duration > 0 && (
          <Text dimColor> ({block.duration}ms)</Text>
        )}
      </Box>

      {/* Show output for errors or expanded blocks */}
      {block.output && (block.isExpanded || isError) && (
        <Box marginLeft={3} marginTop={0}>
          <Text
            color={isError ? "red" : undefined}
            dimColor={!isError}
            wrap="truncate-end"
          >
            {block.output.length > 800
              ? block.output.slice(0, 797) + "..."
              : block.output}
          </Text>
        </Box>
      )}
    </Box>
  );
}
