




import { spawn } from "child_process";
import { resolve } from "path";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { BASH_TOOL_NAME, DESCRIPTION } from "./prompt.js";
import { registerTask } from "../../services/tasks/backgroundFramework.js";



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
const MAX_OUTPUT_BYTES = 50_000;



export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
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

    return new Promise<{ data: string }>((resolvePromise) => {
      // detached + own process group so a timeout/cancel can kill the whole
      // tree (sh -c children survive a bare sh kill otherwise).
      const child = spawn("sh", ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let stderrCapped = false;
      let stdoutCapped = false;

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

      const settle = (data: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ data });
      };

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (!stdoutCapped) {
          stdout += chunk;
          if (stdout.length > MAX_OUTPUT_BYTES) {
            stdoutCapped = true;
            stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
            killGroup();
            settle(`(output truncated at 50KB)\n${stdout}`);
            return;
          }
        }
        if (context.onToolOutput) {
          context.onToolOutput("Bash", chunk);
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        // stderr was unbounded before — a chatty command could grow it
        // without limit. Cap it like stdout (kept for the error summary).
        if (!stderrCapped) {
          stderr += chunk;
          if (stderr.length > MAX_OUTPUT_BYTES) {
            stderrCapped = true;
            stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n... (stderr truncated at 50KB)";
          }
        }
        if (context.onToolOutput) {
          context.onToolOutput("Bash", chunk);
        }
      });

      const timer = setTimeout(() => {
        killGroup();
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
        settle(`Command timed out after ${timeout}ms\n${output}`);
      }, timeout);

      // User cancel: abort the whole group instead of orphaning the process.
      const abortHandler = () => {
        killGroup();
        settle("Aborted/Cancelled by user");
      };
      context.abortController?.signal.addEventListener("abort", abortHandler);

      child.on("close", (code: number | null) => {
        context.abortController?.signal.removeEventListener("abort", abortHandler);
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
        if (code === 0) {
          settle(output || "(no output)");
        } else {
          settle(`Exit code ${code}\n${output}`);
        }
      });

      child.on("error", (error: Error) => {
        context.abortController?.signal.removeEventListener("abort", abortHandler);
        settle(`Error: ${error.message}`);
      });
    });
  },
});
