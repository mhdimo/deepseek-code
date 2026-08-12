// On-exit cost / duration summary formatter
//
// Pure, synchronous formatting helpers that turn a session's accumulated
// metrics into a human-readable multi-line string. The integrator prints the
// returned string on process exit (or at any "session ended" boundary).
//
// Adapted from Claude Code's cost-tracker.ts / costHook.ts, but:
//   - No chalk / React / process.on hooks here. This module is pure data -> string.
//   - No global mutable cost state. Callers pass the numbers in.
//   - Reuses DeepSeek's existing formatTokenCount() / formatCost() for visual
//     consistency with the StatusBar and tool blocks.
//
// DeepSeek Code is a Bun + Ink app, but this module deliberately has no React
// or Bun-specific dependencies so it can be unit-tested in isolation.

import { formatCost, formatTokenCount } from "../services/tokenTracker.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** Raw inputs needed to render a session cost summary. All fields are
 *  caller-provided; this module holds no state of its own. */
export interface SessionSummaryInput {
  /** Epoch ms when the session started. */
  startedAtMs: number;
  /** Epoch ms when the session ended (wall clock). */
  endedAtMs: number;
  /** Cumulative prompt/input tokens for the session. */
  inputTokens: number;
  /** Cumulative completion/output tokens for the session. */
  outputTokens: number;
  /** inputTokens + outputTokens. Computed by the caller to avoid mismatch. */
  totalTokens: number;
  /** Estimated total cost in USD for the session. */
  cost: number;
  /** Model id used for the session (e.g. "deepseek-chat"). */
  model: string;
  /** Number of agentic turns / steps the model took. */
  turns: number;
}

// ─── Internal formatting helpers ─────────────────────────────────────────────

/** Pad a label to a fixed column width so the values line up vertically. */
function padLabel(label: string, width = 22): string {
  return label.padEnd(width);
}

/** Format a millisecond duration as e.g. "1m 23s", "45.2s", or "120ms".
 *  Negative or non-finite durations fall back to "0s". */
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

/** Format a token count for display, falling back to a raw integer when the
 *  imported formatter is unavailable (e.g. undefined at import time). */
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

/** Format a USD cost, falling back to a plain `$N` rendering if the imported
 *  formatter is unavailable. */
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

// ─── Public formatter ────────────────────────────────────────────────────────

/**
 * Render a session cost / duration summary as a multi-line string.
 *
 * The output is intentionally plain (no ANSI color) so it renders correctly
 * whether the caller pipes it to stdout, logs it, or wraps it in a chalk dim()
 * for terminal display. The caller controls coloring.
 *
 * Example output:
 *   Session summary:
 *     Duration:            1m 23s
 *     Model:               deepseek-chat
 *     Turns:               7
 *     Tokens (input):      12.3k
 *     Tokens (output):     1.8k
 *     Tokens (total):      14.1k
 *     Estimated cost:      $0.021
 */
export function formatSessionSummary(input: SessionSummaryInput): string {
  const durationMs = Math.max(0, input.endedAtMs - input.startedAtMs);
  const turns = Number.isFinite(input.turns) ? Math.max(0, Math.floor(input.turns)) : 0;
  const inputTokens = Math.max(0, input.inputTokens | 0);
  const outputTokens = Math.max(0, input.outputTokens | 0);
  // Prefer caller-provided total; otherwise derive it to stay self-consistent.
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

// ─── Convenience: one-liner (for compact exit banners) ───────────────────────

/**
 * A compact one-line summary, e.g.:
 *   "Session: 1m 23s · deepseek-chat · 7 turns · 14.1k tokens · $0.021"
 *
 * Useful when the full multi-line block is too verbose (e.g. a single status
 * line on exit). Reuses the same formatting helpers for consistency.
 */
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
