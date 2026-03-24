// Status bar (matches Claude Code's bottom status line)

import React from "react";
import { Box, Text } from "ink";
import type { AgentName, ThinkingMode } from "../core/types.js";

interface StatusBarProps {
  model: string;
  agentName: AgentName;
  tokenCount?: number;
  thinkingMode?: ThinkingMode;
  mcpEnabledCount?: number;
  queueCount?: number;
  currentFile?: string | null;
  awaitingPermission?: boolean;
}

const AGENT_COLORS: Record<string, string> = {
  code: "cyan",
  plan: "yellow",
  review: "magenta",
};

export default function StatusBar({
  model,
  agentName,
  tokenCount = 0,
  thinkingMode = "off",
  mcpEnabledCount = 0,
  queueCount = 0,
  currentFile = null,
  awaitingPermission = false,
}: StatusBarProps) {
  const cols = process.stdout.columns || 80;
  const separator = "─".repeat(cols);
  const agentColor = AGENT_COLORS[agentName] || "cyan";

  // Shorten file path for display
  const displayFile = currentFile
    ? currentFile.length > 40
      ? "…" + currentFile.slice(-37)
      : currentFile
    : null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{separator}</Text>
      </Box>

      <Box justifyContent="space-between" paddingX={0}>
        {/* Left side: shortcuts */}
        <Box>
          <Text dimColor>? for shortcuts</Text>
        </Box>

        {/* Right side: context */}
        <Box>
          <Text dimColor>
            <Text color={agentColor}>⧉</Text> In {agentName}
            {displayFile ? ` · 📄 ${displayFile}` : ""}
            {thinkingMode === "whale" ? (
              <>
                {" · "}
                <Text backgroundColor="blue" color="white" bold> 🐋 WHALETHINK </Text>
              </>
            ) : ""}
            {mcpEnabledCount > 0 ? ` · MCP ${mcpEnabledCount}` : ""}
            {awaitingPermission ? " · ⚡ permission" : ""}
            {queueCount > 0 ? ` · queue ${queueCount}` : ""}
            {tokenCount > 0 ? ` · ${tokenCount > 1000 ? `${(tokenCount / 1000).toFixed(1)}k` : tokenCount} tok` : ""}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
