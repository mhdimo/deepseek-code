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
  thinkingMode?: ThinkingMode;
  mcpEnabledCount?: number;
  queueCount?: number;
  queuePreview?: string;
  currentFile?: string | null;
  awaitingPermission?: boolean;
  cost?: number;
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
  thinkingMode = "off",
  mcpEnabledCount = 0,
  queueCount = 0,
  queuePreview,
  currentFile = null,
  awaitingPermission = false,
  cost,
}: StatusBarProps) {
  const cols = process.stdout.columns || 80;
  const separator = "─".repeat(cols);
  const agentColor = AGENT_COLORS[agentName] || theme.assistant;

  const displayFile = currentFile
    ? currentFile.length > 40
      ? "…" + currentFile.slice(-37)
      : currentFile
    : null;

  const calculatedCost = cost ?? estimateCost(model, tokenCount);

  // Right-side indicators
  const parts: string[] = [];

  // Agent badge
  parts.push("");
  parts.push(agentName);

  if (displayFile) parts.push(`📄 ${displayFile}`);

  if (thinkingMode === "whale") {
    parts.push("🐋 WHALE");
  }
  if (mcpEnabledCount > 0) parts.push(`MCP ${mcpEnabledCount}`);
  if (awaitingPermission) parts.push("⚡ permission");
  if (queueCount === 1 && queuePreview) {
    const preview = queuePreview.length > 30 ? queuePreview.slice(0, 29) + "…" : queuePreview;
    parts.push(`queue: "${preview}"`);
  } else if (queueCount > 1) {
    parts.push(`queue ${queueCount}`);
  }
  if (tokenCount > 0) {
    parts.push(`${formatTokens(tokenCount)} tok`);
    parts.push(`~${formatCost(calculatedCost)}`);
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{separator}</Text>
      </Box>
      <Box paddingX={0}>
        {/* Left: model name */}
        <Box>
          <Text bold>{model} </Text>
        </Box>

        {/* Right: indicators */}
        <Box flexGrow={1} justifyContent="flex-end">
          <Text dimColor>
            {parts.map((p, i) => (
              <React.Fragment key={i}>
                {i === 0 ? (
                  <Text color={agentColor}>⧉</Text>
                ) : (
                  ` · ${p}`
                )}
              </React.Fragment>
            ))}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
