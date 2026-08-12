// SleepTool — pauses for a given number of milliseconds
//
// A lightweight, read-only, concurrency-safe timer. Useful for polling: call it
// between checks rather than busy-waiting. Preferring this over `Bash(sleep N)`
// avoids holding a shell process and keeps the TUI responsive.
//
// The sleep is abortable: if the run's AbortController fires (e.g. the user
// cancels), the pending timer is rejected immediately.

import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { SLEEP_TOOL_NAME, DESCRIPTION } from "./prompt.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum allowed sleep duration: 10 minutes. */
const MAX_DURATION_MS = 600_000;

// ─── Input schema ────────────────────────────────────────────────────────────

const SleepInputSchema = z.object({
  duration_ms: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Number of milliseconds to sleep. Clamped to the range 0–600000 (10 minutes).",
    ),
});

// ─── Abortable sleep ─────────────────────────────────────────────────────────

/**
 * Resolve after `ms` milliseconds, unless `signal` aborts first.
 * Cleans up its timer + listener on resolve/reject so nothing leaks.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("❌ Aborted/Cancelled by user"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error("❌ Aborted/Cancelled by user"));
    };
    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── Tool definition ────────────────────────────────────────────────────────

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: SleepInputSchema,

  userFacingName: (input) => {
    const ms: number = Number(input?.duration_ms) || 0;
    return `Sleep ${ms}ms`;
  },

  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  maxResultSizeChars: 1_000,

  // No permission gating — sleeping is harmless and read-only.
  checkPermissions: async () => ({ approved: true }),

  call: async (input, context) => {
    const requested = Number(input.duration_ms);
    const durationMs = Math.max(0, Math.min(MAX_DURATION_MS, Math.trunc(requested)));

    if (durationMs <= 0) {
      return { data: `Slept 0ms` };
    }

    const start = Date.now();
    try {
      await sleep(durationMs, context.abortController.signal);
    } catch (error) {
      // Abort/cancel — surface to caller so the binding layer can flag it.
      const elapsed = Date.now() - start;
      throw new Error(
        `Sleep interrupted after ${elapsed}ms: ${(error as Error).message}`,
      );
    }
    const elapsed = Date.now() - start;
    return { data: `Slept ${elapsed}ms` };
  },
});
