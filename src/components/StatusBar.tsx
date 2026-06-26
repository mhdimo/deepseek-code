// Status bar — model, tokens, cost display
//
// Layout:
// ──────────────────────────────────────────────────────
// deepseek-chat  · code  · 1.2k tok  · ~$0.02  · 📄 App.tsx

import React from "react";
import { Box, Text } from "ink";
import { theme } from "../utils/theme.js";
import type { AgentName, ThinkingMode } from "../types/index.js";

interface StatusBarProps {
  model: string;
  agentName: AgentName;
  tokenCount?: number;
  /** Prompt/context tokens (→ in). Preferred over tokenCount when > 0. */
  inputTokens?: number;
  /** Completion tokens (↑ out). */
  outputTokens?: number;
  thinkingMode?: ThinkingMode;
  mcpEnabledCount?: number;
  queueCount?: number;
  queuePreview?: string;
  currentFile?: string | null;
  awaitingPermission?: boolean;
  cost?: number;
  inspectMode?: boolean;
}

const AGENT_COLORS: Record<string, string> = {
  code: theme.assistant,
  plan: theme.warning,
  review: "magenta",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(cost: number): string {
  if (cost < 0.0001) return "<$0.001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

// DeepSeek pricing per 1M tokens (blended estimate)
function estimateCost(model: string, tokens: number): number {
  const pricing: Record<string, number> = {
    "deepseek-chat": 0.27,
    "deepseek-reasoner": 0.55,
  };
  const perMillion = pricing[model] ?? 0.69;
  return (tokens / 1_000_000) * perMillion;
}

export default function StatusBar({
  model,
  agentName,
  tokenCount = 0,
  inputTokens = 0,
  outputTokens = 0,
  thinkingMode = "off",
  mcpEnabledCount = 0,
  queueCount = 0,
  queuePreview,
  currentFile = null,
  awaitingPermission = false,
  cost,
  inspectMode = false,
}: StatusBarProps) {
  const cols = process.stdout.columns || 80;
  const separator = "─".repeat(cols);
  const agentColor = AGENT_COLORS[agentName] || theme.assistant;

  const displayFile = currentFile
    ? currentFile.length > 40
      ? "…" + currentFile.slice(-37)
      : currentFile
    : null;

  const totalForCost = inputTokens + outputTokens > 0 ? inputTokens + outputTokens : tokenCount;
  const calculatedCost = cost ?? estimateCost(model, totalForCost);

  // Context-window usage (DeepSeek v4 = 1M). Colored bar, green→yellow→red.
  const usedPct = Math.min(100, Math.round((totalForCost / 1_000_000) * 100));
  const barLen = 10;
  const filled = Math.round((usedPct / 100) * barLen);
  const ctxBar = "█".repeat(filled) + "░".repeat(barLen - filled);
  const ctxColor = usedPct > 80 ? "red" : usedPct > 50 ? "yellow" : "green";
  const hasTokens = inputTokens + outputTokens > 0 || tokenCount > 0;

  return (
    <Box paddingX={2}>
      {/* Left: model + mode badges */}
      <Box>
        <Text>{model}</Text>
        {agentName !== "code" && (
          <Text dimColor>
            {" · "}
            <Text color={agentColor} bold>
              {agentName}
            </Text>
          </Text>
        )}
        {displayFile && <Text dimColor> · {displayFile}</Text>}
        {thinkingMode === "whale" && <Text color="magenta" bold> · WHALE</Text>}
        {mcpEnabledCount > 0 && <Text dimColor> · MCP {mcpEnabledCount}</Text>}
      </Box>

      {/* Right: context usage bar + tokens + cost */}
      <Box flexGrow={1} justifyContent="flex-end">
        {hasTokens ? (
          <Text>
            <Text color={ctxColor}>{ctxBar}</Text>
            <Text dimColor> {100 - usedPct}%</Text>
            <Text dimColor>
              {" · ↓"}
              {formatTokens(inputTokens)}
              {" ↑"}
              {formatTokens(outputTokens)}
            </Text>
            <Text dimColor> · ~{formatCost(calculatedCost)}</Text>
            {inspectMode && <Text color="cyan" bold> · INSPECT</Text>}
            {awaitingPermission && <Text color="yellow"> · permission</Text>}
            {queueCount > 0 && <Text dimColor> · queue {queueCount}</Text>}
          </Text>
        ) : (
          <Text dimColor>
            {inspectMode ? "INSPECT" : ""}
            {awaitingPermission ? "permission" : ""}
          </Text>
        )}
      </Box>
    </Box>
  );
}
