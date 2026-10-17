import React from "react";
import { Box, Text } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import { parseAnsi } from "../utils/statusline.js";
import { formatWorkingDirectory } from "../utils/gitStatus.js";
import { DEFAULT_CONTEXT_WINDOW, RESERVED_OUTPUT_TOKENS } from "../services/contextManager.js";
import { inputRatePerMillion } from "../services/tokenTracker.js";
import type { AgentName, TokenBudget } from "../types/index.js";
import type { EffortLevel } from "../state/storage.js";
import type { PermissionMode } from "../services/bypassMode.js";


interface StatusBarProps {
  model: string;
  agentName: AgentName;

  /** The workspace the session runs in, and its git state when it has one.
   *  Both segments are simply absent outside a repository — the bar is not
   *  the place to report a missing git. */
  workingDirectory?: string;
  branch?: string;
  branchDirty?: boolean;

  /** Generated tokens per second over the session's model calls. 0 until one
   *  has finished: a rate with no elapsed time behind it is not a rate. */
  tokensPerSecond?: number;

  /** settings.outputStyle — the label the bar carries as `[name]`. Unset and
   *  "default" are the same thing here and neither renders. */
  outputStyle?: string;

  isLoading?: boolean;
  tokenCount?: number;

  inputTokens?: number;

  outputTokens?: number;

  /** Input tokens the last request sent — what the context window holds. The
   *  engine reports it per turn (services/contextUsage.ts); 0 until it has. */
  contextTokens?: number;

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
  permissionMode?: PermissionMode;

  tokenBudget?: TokenBudget;

  statusLineOutput?: string | null;
  /** settings.statusLine.padding — spacing for the bar when a statusline is configured. */
  statusLinePadding?: number;

  tasks?: { done: number; total: number; inProgress: number; expanded: boolean };

  /** The prompt is in shell mode: the bar steps aside for a moment and says
   *  so — the one thing that matters while Enter is about to run a command. */
  bashMode?: boolean;
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
  auto: "⏵⏵",
  bypassPermissions: "⏵⏵",
};

/** Reference PermissionMode.ts titles, rendered lowercased + " on". */
const PERMISSION_MODE_TITLES: Record<string, string> = {
  plan: "Plan Mode",
  acceptEdits: "Accept edits",
  auto: "Auto mode",
  bypassPermissions: "Bypass Permissions",
};

/** Reference getModeColor: plan → planMode, acceptEdits → autoAccept,
 *  bypassPermissions → error. Auto mode has its own gold rather than a palette
 *  token: the mode is this app's, the colour is part of its identity, and it
 *  has to say "the agent is deciding" in a shade that is not the error red and
 *  not the plan teal. */
const PERMISSION_MODE_COLORS: Record<string, string> = {
  plan: "planMode",
  acceptEdits: "autoAccept",
  bypassPermissions: "error",
};

const AUTO_MODE_COLOR = "rgb(253, 191, 7)";

/** The default mode's own chip: nothing is settled for you, so the chip says
 *  so rather than disappearing — the line keeps its shape and its meaning
 *  whatever mode you are in. Reads in the muted grey, since a mode that does
 *  nothing on your behalf has nothing to announce. */
const MANUAL_MODE_SYMBOL = "⏸";
const MANUAL_MODE_COLOR = "inactive";

function formatCost(cost: number): string {
  if (cost < 0.0001) return "<$0.001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}


/** Before the first finish reports a real cost: the session's tokens at the
 *  model's input rate. The reported figure replaces it as soon as one arrives. */
function estimateCost(model: string, tokens: number): number {
  return (tokens / 1_000_000) * inputRatePerMillion(model);
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
  workingDirectory,
  branch,
  branchDirty = false,
  tokensPerSecond = 0,
  outputStyle,
  isLoading = false,
  tokenCount = 0,
  inputTokens = 0,
  outputTokens = 0,
  contextTokens = 0,
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
  bashMode = false,
}: StatusBarProps) {
  // Shell mode draws over the status line for as long as it is active: the
  // mode is momentary, and the regular bar's model/context/telemetry has
  // nothing to say until the command has run.
  if (bashMode) {
    return (
      <Box paddingX={statusLinePadding ?? 2}>
        <Text color={resolveColor(theme.bashBorder)}>shell mode</Text>
      </Box>
    );
  }
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

  // What fills the window is the conversation, not the turn that last wrote
  // into it: the engine's context figure (the last request's input) when it
  // has one. The turn's own input and output — `totalForCost` above, which is
  // what this used to measure — count every call and every token the model
  // wrote, so a long tool-using turn read as a full window.
  const usedTokens = contextTokens || inputTokens || tokenCount;
  const usedPct = effectiveMax > 0
    ? Math.min(100, Math.round((usedTokens / effectiveMax) * 100))
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
  // The engine compacts on its own; the readout says how much headroom is
  // left until it does — just the number, no prose. Once the bar is in its
  // error band the advice joins it.
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

      {/* The standard row: model │ directory │ branch │ context │ rate │ style.
          It is the same row from a fresh session as from the twentieth turn —
          every segment renders whether or not anything has been spent yet, so
          the bar reads as one line that fills in rather than one that appears.
          Anything else the session has to say (agent, effort, MCP, file, cost)
          is appended after the standard six. */}
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
            {workingDirectory && (
              <Text dimColor>
                {" │ "}
                {formatWorkingDirectory(workingDirectory)}
              </Text>
            )}
            {branch && (
              <Text dimColor>
                {" │ ⎇ "}
                {branch}
                {branchDirty ? "*" : ""}
              </Text>
            )}
            <Text dimColor>{" │ "}</Text>
            <Text color={ctxColor}>{ctxBar}</Text>
            <Text dimColor>{` ${usedPct}%`}</Text>
            {contextLow && (
              <Text color={resolveColor(theme.error)}>{" · Context low · Run /compact to compact & continue"}</Text>
            )}
            {tokensPerSecond > 0 && (
              <Text dimColor>{` │ ${Math.round(tokensPerSecond)} tok/s`}</Text>
            )}
            {outputStyle && <Text dimColor>{" │ ["}{outputStyle}{"]"}</Text>}
            {agentName !== "code" && (
              <Text dimColor>
                {" · "}
                <Text color={agentColor} bold>
                  {agentName}
                </Text>
              </Text>
            )}
            {effortChip && <Text dimColor>{effortChip}</Text>}
            {mcpEnabledCount > 0 && <Text dimColor> · MCP {mcpEnabledCount}</Text>}
            {displayFile && <Text dimColor> · {displayFile}</Text>}
            {usedTokens > 0 && (
              <Text dimColor>
                {" · ~"}
                {formatCost(calculatedCost)}
              </Text>
            )}
            {inspectMode && <Text color="cyan" bold> · INSPECT</Text>}
            {queueCount > 0 && <Text dimColor> · queue {queueCount}</Text>}
          </Text>
        </Box>

        {}
      </Box>

      {}
      {/* Row two: what the session may do to your files on the left — the
          permission mode — and how to drive the app on the right. The mode
          chip sits here rather than beside the model so the standard row
          above is the same line whatever mode you are in. */}
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>
          {permissionMode === "default" ? (
            <Text color={themeColor(MANUAL_MODE_COLOR)} wrap="truncate-end">
              {`${MANUAL_MODE_SYMBOL} manual mode on`}
            </Text>
          ) : (
            <Text
              color={
                permissionMode === "auto"
                  ? AUTO_MODE_COLOR
                  : themeColor(PERMISSION_MODE_COLORS[permissionMode] ?? "text")
              }
              bold
              wrap="truncate-end"
            >
              {modeSymbol ? `${modeSymbol} ` : ""}
              {(PERMISSION_MODE_TITLES[permissionMode] ?? permissionMode).toLowerCase()} on
              <Text dimColor> (shift+tab to cycle)</Text>
            </Text>
          )}
        </Box>
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
