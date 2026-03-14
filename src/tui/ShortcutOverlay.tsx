import React from "react";
import { Box, Text } from "ink";
import type { ThinkingMode } from "../core/types.js";

interface ShortcutOverlayProps {
  thinkingMode: ThinkingMode;
  mcpCount: number;
  mcpEnabledCount: number;
  onCloseHint?: string;
}

export default function ShortcutOverlay({
  thinkingMode,
  mcpCount,
  mcpEnabledCount,
  onCloseHint = "Press ? or Esc to close",
}: ShortcutOverlayProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Text bold color="yellow">Shortcuts & options</Text>
      <Text dimColor> </Text>
      <Text>  ?                 Toggle this shortcuts panel</Text>
      <Text>  / + ↑↓ + Enter    Open and navigate command picker</Text>
      <Text>  Shift+Tab         Cycle thinking mode</Text>
      <Text>  Esc               Interrupt generation / close picker</Text>
      <Text>  Ctrl+C            Exit zcode</Text>
      <Text dimColor> </Text>
      <Text>Thinking mode: <Text color="magenta">{thinkingMode}</Text></Text>
      <Text>MCP servers: <Text color="cyan">{mcpEnabledCount}/{mcpCount}</Text> enabled</Text>
      <Text dimColor>{onCloseHint}</Text>
    </Box>
  );
}
