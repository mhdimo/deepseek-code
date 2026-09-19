




import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { resolve } from "path";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { BASH_TOOL_NAME, DESCRIPTION } from "./prompt.js";
import { registerTask } from "../../services/tasks/backgroundFramework.js";
import {
  type Spill,
  closeSpill,
  openSpill,
  spillNote,
  spillPath,
  writeSpill,
} from "../../services/toolOutputs.js";



const BashInputSchema = z.object({
  command: z.string().describe(
    "The bash command to run",
  ),
  timeout: z.number().optional().describe(
    "Optional timeout in milliseconds (up to 600000ms / 10 minutes). Default is 120000ms (2 minutes).",
  ),
  run_in_background: z.boolean().optional().describe(
    "Set to true to run the command in the background as a detached process. " +
      "Use this only when you do not need the result immediately and are OK being notified " +
      "later when the command completes. When true, the tool returns a background task id " +
      "immediately instead of waiting for the command to finish; stdout/stderr are written to " +
      "the returned output file path. Do not add a trailing '&' to the command when using this. " +
      "Use TaskOutput to read the tail of the output and TaskStop to kill the task.",
  ),
});



const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
/** What the result shows inline. Past this the whole stream goes to a file. */
const MAX_OUTPUT_BYTES = 50_000;

/**
 * One stream's output, split between what the model sees inline and the file
 * the rest goes to. Overflow is a paging decision, never a reason to kill the
 * command — see services/toolOutputs.ts.
 */
interface StreamCapture {
  inline: string;
  spill: Spill | null;
}

/** Append a chunk, spilling to `path` once the inline head is full. */
function capture(state: StreamCapture, path: string, chunk: string): void {
  if (state.spill) {
    writeSpill(state.spill, chunk);
    return;
  }
  const combined = state.inline + chunk;
  if (combined.length <= MAX_OUTPUT_BYTES) {
    state.inline = combined;
    return;
  }
  state.spill = openSpill(path, combined);
  state.inline = combined.slice(0, MAX_OUTPUT_BYTES);
}

/**
 * Where a stream's full output went, or "" if it all fit.
 *
 * A header rather than a note appended to the stream: results are themselves
 * capped by the tool runner, which cuts the tail — exactly where a trailing
 * pointer, the one thing here the model cannot reconstruct, would be lost.
 */
function spillHeader(state: StreamCapture, which: "stdout" | "stderr"): string {
  if (!state.spill) return "";
  return `[${which} truncated at ${MAX_OUTPUT_BYTES / 1000}KB; ${spillNote(state.spill)}]\n`;
}



export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  requiredPermission: "allowExecute",
  description: DESCRIPTION,
  inputSchema: BashInputSchema,

  userFacingName: (input) => input.run_in_background ? "Bash (background)" : "Bash",

  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  maxResultSizeChars: 100_000,

  checkPermissions: async (input, context) => {
    if (!context.permissions.allowExecute) {
      return { approved: false, feedback: "Execute permission denied for this agent." };
    }

    return context.requestPermission("Bash", input.command);
  },

  call: async (input, context) => {
    const { command } = input;
    const cwd = resolve(context.workingDir);

    
    
    
    
    
    if (input.run_in_background) {
      try {
        const task = registerTask(command, {
          cwd,
          env: { FORCE_COLOR: "0" },
        });
        return {
          data:
            `Background task started.\n` +
            `task_id: ${task.id}\n` +
            `pid: ${task.pid ?? "unknown"}\n` +
            `output_file: ${task.outputPath}\n` +
            `command: ${task.command}\n` +
            `Use TaskOutput to read the latest output, and TaskStop to kill it.`,
        };
      } catch (error) {
        return { data: `Error starting background task: ${(error as Error).message}` };
      }
    }

    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    // Names the spill files, created only if this command overflows.
    const taskId = randomUUID().slice(0, 8);

    return new Promise<{ data: string }>((resolvePromise) => {
      // detached + own process group so a timeout/cancel can kill the whole
      // tree (sh -c children survive a bare sh kill otherwise).
      const child = spawn("sh", ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
        detached: true,
      });

      const out: StreamCapture = { inline: "", spill: null };
      const err: StreamCapture = { inline: "", spill: null };
      let settled = false;

      const killGroup = () => {
        try {
          process.kill(-(child.pid ?? 0), "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        // Escalate: give the group a moment, then SIGKILL.
        setTimeout(() => {
          try {
            process.kill(-(child.pid ?? 0), "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 1500).unref();
      };

      // Both streams are finished before the result is handed back, so a path
      // the result advertises is complete by the time the model reads it.
      const settle = (data: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void Promise.all([closeSpill(out.spill), closeSpill(err.spill)]).then(() =>
          resolvePromise({ data }),
        );
      };

      const output = (): string => {
        const header = spillHeader(out, "stdout") + spillHeader(err, "stderr");
        return header + out.inline + (err.inline ? `\nSTDERR:\n${err.inline}` : "");
      };

      const stdoutSpill = spillPath(taskId, "stdout");
      const stderrSpill = spillPath(taskId, "stderr");

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        capture(out, stdoutSpill, chunk);
        if (context.onToolOutput) {
          context.onToolOutput("Bash", chunk);
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        capture(err, stderrSpill, chunk);
        if (context.onToolOutput) {
          context.onToolOutput("Bash", chunk);
        }
      });

      const timer = setTimeout(() => {
        killGroup();
        settle(`Command timed out after ${timeout}ms\n${output()}`);
      }, timeout);

      // User cancel: abort the whole group instead of orphaning the process.
      const abortHandler = () => {
        killGroup();
        settle("Aborted/Cancelled by user");
      };
      context.abortController?.signal.addEventListener("abort", abortHandler);

      child.on("close", (code: number | null) => {
        context.abortController?.signal.removeEventListener("abort", abortHandler);
        const text = output();
        if (code === 0) {
          settle(text || "(no output)");
        } else {
          settle(`Exit code ${code}\n${text}`);
        }
      });

      child.on("error", (error: Error) => {
        context.abortController?.signal.removeEventListener("abort", abortHandler);
        settle(`Error: ${error.message}`);
      });
    });
  },
});
