








import React from "react";
import { Box, Text } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import type { AgentName, ThinkingMode, TokenBudget } from "../types/index.js";
import type { EffortLevel } from "../state/storage.js";


interface StatusBarProps {
  model: string;
  agentName: AgentName;
  
  isLoading?: boolean;
  tokenCount?: number;
  
  inputTokens?: number;
  
  outputTokens?: number;
  thinkingMode?: ThinkingMode;
  
  effort?: EffortLevel;
  mcpEnabledCount?: number;
  queueCount?: number;
  queuePreview?: string;
  currentFile?: string | null;
  awaitingPermission?: boolean;
  cost?: number;
  inspectMode?: boolean;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  
  tokenBudget?: TokenBudget;
  
  statusLineOutput?: string | null;
  
  tasks?: { done: number; total: number; inProgress: number; expanded: boolean };
}

const AGENT_COLORS: Record<string, string> = {
  code: theme.claude,
  plan: theme.warning,
  review: "magenta",
};




const EFFORT_SYMBOLS: Record<string, string> = {
  low: "○",
  medium: "◐",
  high: "●",
  xhigh: "◈",
  max: "◉",
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
  isLoading = false,
  tokenCount = 0,
  inputTokens = 0,
  outputTokens = 0,
  thinkingMode = "off",
  effort,
  mcpEnabledCount = 0,
  queueCount = 0,
  queuePreview,
  currentFile = null,
  awaitingPermission = false,
  cost,
  inspectMode = false,
  permissionMode = "default",
  tokenBudget,
  statusLineOutput,
  tasks,
}: StatusBarProps) {
  const cols = process.stdout.columns || 80;
  const separator = "─".repeat(cols);
  const agentColor = AGENT_COLORS[agentName] || theme.claude;
  const dim = theme.inactive;

  const displayFile = currentFile
    ? currentFile.length > 40
      ? "…" + currentFile.slice(-37)
      : currentFile
    : null;

  const totalForCost = inputTokens + outputTokens > 0 ? inputTokens + outputTokens : tokenCount;
  const calculatedCost = cost ?? estimateCost(model, totalForCost);

  
  const maxContext =
    tokenBudget?.maxContextTokens ?? 1_000_000;
  const reservedOutput = tokenBudget?.reservedForResponse ?? 4096;
  const effectiveMax = maxContext - reservedOutput;

  const usedPct = effectiveMax > 0
    ? Math.min(100, Math.round((totalForCost / effectiveMax) * 100))
    : 0;
  const barLen = 10;
  const filled = Math.round((usedPct / 100) * barLen);
  const ctxBar = "█".repeat(filled) + "░".repeat(barLen - filled);
  
  const ctxColor =
    usedPct > 80
      ? resolveColor(theme.error)
      : usedPct > 50
        ? resolveColor(theme.warning)
        : resolveColor(theme.success);
  const hasTokens = inputTokens + outputTokens > 0 || tokenCount > 0;

  
  const effortChip =
    effort && effort !== "off"
      ? ` · ${EFFORT_SYMBOLS[effort] ?? "●"} ${effort}`
      : null;

  
  
  
  const rightHints = statusLineOutput
    ? null
    : awaitingPermission
      ? "enter to confirm · esc to cancel"
      : isLoading
        ? "esc to interrupt"
        : "? for shortcuts · ↑/↓ for history";

  return (
    <Box paddingX={2} flexDirection="row" justifyContent="space-between">
      {}
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          {tasks && tasks.total > 0 && (
            <Text
              color={tasks.expanded ? resolveColor(theme.claude) : resolveColor(theme.inactive)}
              bold={tasks.expanded}
            >
              {`▸ ${tasks.done}/${tasks.total} tasks`}
              {tasks.inProgress > 0 ? ` · ${tasks.inProgress} in progress` : ""}
              {" · "}
            </Text>
          )}
          <Text color={resolveColor(theme.text)}>{model}</Text>
          {permissionMode !== "default" && (
            <Text
              color={permissionMode === "plan" ? resolveColor(theme.warning) : permissionMode === "bypassPermissions" ? resolveColor(theme.error) : resolveColor(theme.success)}
              bold
            >
              {permissionMode === "acceptEdits"
                ? " · accept edits"
                : permissionMode === "plan"
                  ? " · plan mode"
                  : " · bypass perms"}
            </Text>
          )}
          {agentName !== "code" && (
            <Text dimColor>
              {" · "}
              <Text color={agentColor} bold>
                {agentName}
              </Text>
            </Text>
          )}
          {thinkingMode === "whale" && <Text color="magenta" bold> · WHALE</Text>}
          {effortChip && <Text dimColor>{effortChip}</Text>}
          {mcpEnabledCount > 0 && <Text dimColor> · MCP {mcpEnabledCount}</Text>}
          {displayFile && <Text dimColor> · {displayFile}</Text>}
          {hasTokens && (
            <Text dimColor>
              {" · "}
              <Text color={ctxColor}>{ctxBar}</Text>
              {` ${100 - usedPct}%`}
              {" · ↓"}
              {formatTokens(inputTokens)}
              {" ↑"}
              {formatTokens(outputTokens)}
              {" · ~"}
              {formatCost(calculatedCost)}
            </Text>
          )}
          {inspectMode && <Text color="cyan" bold> · INSPECT</Text>}
          {queueCount > 0 && <Text dimColor> · queue {queueCount}</Text>}
        </Text>
      </Box>

      {}
      <Box flexShrink={1}>
        <Text dimColor wrap="truncate-end">
          {statusLineOutput ? statusLineOutput : ` · ${rightHints}`}
        </Text>
      </Box>
    </Box>
  );
}
