import React from "react";
import { Box, Text } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import { parseAnsi } from "../utils/statusline.js";
import { DEFAULT_CONTEXT_WINDOW, RESERVED_OUTPUT_TOKENS } from "../services/contextManager.js";
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
  /** Accepted for API compatibility but unused: the reference has no
   *  permission hint in its status row — the dialog carries
   *  "Esc to cancel · Tab to amend" itself. */
  awaitingPermission?: boolean;
  cost?: number;
  inspectMode?: boolean;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";

  tokenBudget?: TokenBudget;

  statusLineOutput?: string | null;
  /** settings.statusLine.padding — spacing for the bar when a statusline is configured. */
  statusLinePadding?: number;

  tasks?: { done: number; total: number; inProgress: number; expanded: boolean };
}

// Token NAMES, resolved against the LIVE legacy theme at render time —
// snapshotting theme.claude here kept the agent color stale after a
// mid-session /theme switch (setThemeMode keeps the mutable palette in sync).
const AGENT_COLORS: Record<string, string> = {
  code: "claude",
  plan: "warning",
  review: "magenta",
};




const EFFORT_SYMBOLS: Record<string, string> = {
  low: "○",
  medium: "◐",
  high: "●",
  xhigh: "◈",
  max: "◉",
};

/** Reference PermissionMode.ts — per-mode symbol. ⏸ is PAUSE_ICON, ⏵⏵ the
 *  accept-edits/bypass run icon. */
const PERMISSION_MODE_SYMBOLS: Record<string, string> = {
  plan: "⏸",
  acceptEdits: "⏵⏵",
  bypassPermissions: "⏵⏵",
};

/** Reference PermissionMode.ts titles, rendered lowercased + " on". */
const PERMISSION_MODE_TITLES: Record<string, string> = {
  plan: "Plan Mode",
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass Permissions",
};

/** Reference getModeColor: plan → planMode, acceptEdits → autoAccept,
 *  bypassPermissions → error. */
const PERMISSION_MODE_COLORS: Record<string, string> = {
  plan: "planMode",
  acceptEdits: "autoAccept",
  bypassPermissions: "error",
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

/** Render statusline stdout ANSI-aware; unsupported escapes were stripped by parseAnsi. */
const StatusLineText = React.memo(function StatusLineText({ text }: { text: string }) {
  return (
    <>
      {parseAnsi(text).map((seg, i) => (
        <Text
          key={i}
          color={seg.color}
          backgroundColor={seg.backgroundColor}
          bold={seg.bold}
          dimColor={seg.dim}
          underline={seg.underline}
          inverse={seg.inverse}
          strikethrough={seg.strikethrough}
        >
          {seg.text}
        </Text>
      ))}
    </>
  );
});

/** Theme token lookup that tolerates a palette without the token. */
function themeColor(token: string): string {
  const value = (theme as Record<string, unknown>)[token];
  return resolveColor(typeof value === "string" ? value : theme.text);
}

export default React.memo(function StatusBar({
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
  cost,
  inspectMode = false,
  permissionMode = "default",
  tokenBudget,
  statusLineOutput,
  statusLinePadding,
  tasks,
}: StatusBarProps) {
  const agentColor =
    agentName === "review"
      ? "magenta"
      : ((theme as Record<string, unknown>)[AGENT_COLORS[agentName] ?? "claude"] as string) ?? theme.claude;

  const displayFile = currentFile
    ? currentFile.length > 40
      ? "…" + currentFile.slice(-37)
      : currentFile
    : null;

  const totalForCost = inputTokens + outputTokens > 0 ? inputTokens + outputTokens : tokenCount;
  const calculatedCost = cost ?? estimateCost(model, totalForCost);


  const maxContext = tokenBudget?.maxContextTokens ?? DEFAULT_CONTEXT_WINDOW;
  const reservedOutput = tokenBudget?.reservedForResponse ?? RESERVED_OUTPUT_TOKENS;
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
  // The engine compacts on its own, so the readout carries the reference's
  // auto-compact-enabled wording ("12% until auto-compact"); once the bar is
  // in its error band the reference's /compact advice replaces it.
  const contextLow = usedPct > 80;


  const effortChip =
    effort && effort !== "off"
      ? ` · ${EFFORT_SYMBOLS[effort] ?? "●"} ${effort}`
      : null;

  // Reference footer: the shortcut hint stands alone, and a configured
  // status line suppresses it entirely.
  const rightHints = statusLineOutput
    ? null
    : isLoading
      ? "esc to interrupt"
      : "? for shortcuts";

  const modeSymbol = PERMISSION_MODE_SYMBOLS[permissionMode] ?? "";

  return (
    <Box paddingX={statusLinePadding ?? 2} flexDirection="column">
      {/* Custom status line: its own left-aligned row above the hint row
          (reference PromptInputFooter stacks StatusLine above the footer). */}
      {statusLineOutput ? (
        <Box>
          <Text dimColor wrap="truncate-end">
            <StatusLineText text={statusLineOutput} />
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="row" justifyContent="space-between">
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
              <Text color={themeColor(PERMISSION_MODE_COLORS[permissionMode] ?? "text")} bold>
                {" · "}
                {modeSymbol ? `${modeSymbol} ` : ""}
                {(PERMISSION_MODE_TITLES[permissionMode] ?? permissionMode).toLowerCase()} on
                <Text dimColor> (shift+tab to cycle)</Text>
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
                {contextLow ? (
                  <Text color={resolveColor(theme.error)}>
                    {` Context low (${100 - usedPct}% remaining) · Run /compact to compact & continue`}
                  </Text>
                ) : (
                  ` ${100 - usedPct}% until auto-compact`
                )}
                {" · ↑ "}
                {formatTokens(inputTokens)}
                {" tokens · ↓ "}
                {formatTokens(outputTokens)}
                {" tokens · ~"}
                {formatCost(calculatedCost)}
              </Text>
            )}
            {inspectMode && <Text color="cyan" bold> · INSPECT</Text>}
            {queueCount > 0 && <Text dimColor> · queue {queueCount}</Text>}
          </Text>
        </Box>

        {}
        {rightHints ? (
          <Box flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {rightHints}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
});
