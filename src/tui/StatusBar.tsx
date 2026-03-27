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

// DeepSeek pricing per 1M tokens (as of 2026-03)
// Input (cache miss): $0.28, Input (cache hit): $0.028, Output: $0.42
// We use a conservative blended estimate (most tokens are input, cache miss)
const PRICING: Record<string, number> = {
  "deepseek-chat": 0.32, // ~80% input @ $0.28 + ~20% output @ $0.42
  "deepseek-reasoner": 0.32,
};

function estimateCost(model: string, tokenCount: number): string {
  const pricePerMillion = PRICING[model] ?? 0.69;
  const cost = (tokenCount / 1_000_000) * pricePerMillion;
  if (cost < 0.001) return "<$0.001";
  if (cost < 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

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
            {tokenCount > 0 ? ` · ${tokenCount > 1000 ? `${(tokenCount / 1000).toFixed(1)}k` : tokenCount} tok ~${estimateCost(model, tokenCount)}` : ""}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
