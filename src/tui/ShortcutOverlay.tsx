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
      <Text bold color="yellow">Shortcuts</Text>
      <Text dimColor> </Text>

      <Text color="cyan">Navigation</Text>
      <Text>  ↑↓                Navigate command picker / input history</Text>
      <Text>  Tab               Confirm command picker selection</Text>
      <Text>  Esc               Interrupt generation / dismiss picker</Text>
      <Text dimColor> </Text>

      <Text color="cyan">Modes</Text>
      <Text>  Shift+Tab         Cycle thinking mode</Text>
      <Text>  ?                 Toggle this shortcuts panel</Text>
      <Text dimColor> </Text>

      <Text color="cyan">Session</Text>
      <Text>  Ctrl+C            Exit DeepSeek Code</Text>
      <Text dimColor> </Text>

      <Box>
        <Text>Thinking: </Text>
        <Text color="magenta">{thinkingMode === "off" ? "off" : "🐋 whalethink"}</Text>
        <Text> · MCP: </Text>
        <Text color="cyan">{mcpEnabledCount}/{mcpCount}</Text>
      </Box>
      <Text dimColor>{onCloseHint}</Text>
    </Box>
  );
}
