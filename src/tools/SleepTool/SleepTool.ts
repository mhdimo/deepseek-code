








import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { SLEEP_TOOL_NAME, DESCRIPTION } from "./prompt.js";




const MAX_DURATION_MS = 600_000;



const SleepInputSchema = z.object({
  duration_ms: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Number of milliseconds to sleep. Clamped to the range 0–600000 (10 minutes).",
    ),
});




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
      
      const elapsed = Date.now() - start;
      throw new Error(
        `Sleep interrupted after ${elapsed}ms: ${(error as Error).message}`,
      );
    }
    const elapsed = Date.now() - start;
    return { data: `Slept ${elapsed}ms` };
  },
});
