import React from "react";
import { Box, Text } from "ink";
import type { ThinkingMode } from "../types/index.js";
import { theme } from "../utils/theme.js";

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
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1} marginBottom={1}>
      <Text bold color={theme.warning}>Shortcuts</Text>
      <Text dimColor> </Text>

      <Text color={theme.assistant}>Navigation</Text>
      <Text>  ↑↓                Navigate command picker / input history</Text>
      <Text>  Tab               Confirm command picker selection / autocomplete</Text>
      <Text>  Esc               Interrupt generation / dismiss picker</Text>
      <Text>  Ctrl+E            Toggle Inspect Mode (expand/collapse tool outputs)</Text>
      <Text dimColor> </Text>

      <Text color={theme.assistant}>Input editing</Text>
      <Text>  Alt+Enter / Ctrl+J Insert newline (multiline mode)</Text>
      <Text>  Home / End         Start / end of current line</Text>
      <Text>  Ctrl+A / Ctrl+E    Start / end of current line</Text>
      <Text>  Ctrl+U             Delete to start of line</Text>
      <Text>  Ctrl+K             Delete to end of line</Text>
      <Text>  Ctrl+W             Delete word backwards</Text>
      <Text dimColor> </Text>

      <Text color={theme.assistant}>Modes</Text>
      <Text>  Shift+Tab         Cycle thinking mode</Text>
      <Text>  ?                 Toggle this shortcuts panel</Text>
      <Text dimColor> </Text>

      <Text color={theme.assistant}>Session</Text>
      <Text>  Ctrl+Q            Clear queued prompts</Text>
      <Text>  Ctrl+C            Exit DeepSeek Code</Text>
      <Text dimColor> </Text>

      <Box>
        <Text>Thinking: </Text>
        <Text color={theme.thinking}>{thinkingMode === "off" ? "off" : "🐋 whalethink"}</Text>
        <Text> · MCP: </Text>
        <Text color={theme.assistant}>{mcpEnabledCount}/{mcpCount}</Text>
      </Box>
      <Text dimColor>{onCloseHint}</Text>
    </Box>
  );
}
