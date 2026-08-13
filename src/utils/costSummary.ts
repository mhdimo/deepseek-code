














import { formatCost, formatTokenCount } from "../services/tokenTracker.js";




export interface SessionSummaryInput {
  
  startedAtMs: number;
  
  endedAtMs: number;
  
  inputTokens: number;
  
  outputTokens: number;
  
  totalTokens: number;
  
  cost: number;
  
  model: string;
  
  turns: number;
}




function padLabel(label: string, width = 22): string {
  return label.padEnd(width);
}


export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = Math.round(totalSeconds % 60);

  if (totalMinutes < 60) {
    return remainingSeconds === 0
      ? `${totalMinutes}m`
      : `${totalMinutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return remainingMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainingMinutes}m`;
}


function safeFormatTokens(n: number): string {
  const fn = formatTokenCount as ((n: number) => string) | undefined;
  if (typeof fn !== "function") {
    return Number.isFinite(n) ? String(Math.round(n)) : "0";
  }
  try {
    return fn(n);
  } catch {
    return String(n);
  }
}


function safeFormatCost(cost: number): string {
  const fn = formatCost as ((cost: number) => string) | undefined;
  if (typeof fn !== "function") {
    return Number.isFinite(cost) ? `$${cost.toFixed(4)}` : "$0";
  }
  try {
    return fn(cost);
  } catch {
    return `$${cost}`;
  }
}




export function formatSessionSummary(input: SessionSummaryInput): string {
  const durationMs = Math.max(0, input.endedAtMs - input.startedAtMs);
  const turns = Number.isFinite(input.turns) ? Math.max(0, Math.floor(input.turns)) : 0;
  const inputTokens = Math.max(0, input.inputTokens | 0);
  const outputTokens = Math.max(0, input.outputTokens | 0);
  
  const totalTokens =
    Number.isFinite(input.totalTokens) && input.totalTokens >= 0
      ? Math.max(input.totalTokens, inputTokens + outputTokens)
      : inputTokens + outputTokens;
  const cost = Number.isFinite(input.cost) ? Math.max(0, input.cost) : 0;

  const lines: string[] = [];
  lines.push("Session summary:");
  lines.push(`${padLabel("  Duration:")}        ${formatDuration(durationMs)}`);
  lines.push(`${padLabel("  Model:")}           ${input.model || "unknown"}`);
  lines.push(`${padLabel("  Turns:")}           ${turns}`);
  lines.push(`${padLabel("  Tokens (input):")}  ${safeFormatTokens(inputTokens)}`);
  lines.push(`${padLabel("  Tokens (output):")} ${safeFormatTokens(outputTokens)}`);
  lines.push(`${padLabel("  Tokens (total):")}  ${safeFormatTokens(totalTokens)}`);
  lines.push(`${padLabel("  Estimated cost:")}  ${safeFormatCost(cost)}`);

  return lines.join("\n");
}




export function formatSessionSummaryLine(input: SessionSummaryInput): string {
  const durationMs = Math.max(0, input.endedAtMs - input.startedAtMs);
  const inputTokens = Math.max(0, input.inputTokens | 0);
  const outputTokens = Math.max(0, input.outputTokens | 0);
  const totalTokens = inputTokens + outputTokens;
  const turns = Number.isFinite(input.turns) ? Math.max(0, Math.floor(input.turns)) : 0;
  const cost = Number.isFinite(input.cost) ? Math.max(0, input.cost) : 0;

  return [
    `Session: ${formatDuration(durationMs)}`,
    input.model || "unknown",
    `${turns} turn${turns === 1 ? "" : "s"}`,
    `${safeFormatTokens(totalTokens)} tokens`,
    safeFormatCost(cost),
  ].join(" · ");
}
