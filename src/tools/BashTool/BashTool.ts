// BashTool — execute shell commands
//
// Spawns commands via sh -c with configurable timeout. Output is truncated
// at 50KB. Permission is requested with a command preview.

import { spawn } from "child_process";
import { resolve } from "path";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { BASH_TOOL_NAME, DESCRIPTION } from "./prompt.js";

// ─── Input schema ────────────────────────────────────────────────────────────

const BashInputSchema = z.object({
  command: z.string().describe(
    "The bash command to run",
  ),
  timeout: z.number().optional().describe(
    "Optional timeout in milliseconds (up to 600000ms / 10 minutes). Default is 120000ms (2 minutes).",
  ),
});

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT_BYTES = 50_000;

// ─── Tool definition ─────────────────────────────────────────────────────────

export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: BashInputSchema,

  userFacingName: (_input) => "Bash",

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
    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const cwd = resolve(context.workingDir);

    return new Promise<{ data: string }>((resolvePromise) => {
      const child = spawn("sh", ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        if (context.onToolOutput) {
          context.onToolOutput("Bash", chunk);
        }
        if (stdout.length > MAX_OUTPUT_BYTES) {
          child.kill();
          resolvePromise({
            data: `(output truncated at 50KB)\n${stdout.slice(0, MAX_OUTPUT_BYTES)}`,
          });
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        if (context.onToolOutput) {
          context.onToolOutput("Bash", chunk);
        }
      });

      const timer = setTimeout(() => {
        child.kill();
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
        resolvePromise({
          data: `Command timed out after ${timeout}ms\n${output}`,
        });
      }, timeout);

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
        if (code === 0) {
          resolvePromise({ data: output || "(no output)" });
        } else {
          resolvePromise({ data: `Exit code ${code}\n${output}` });
        }
      });

      child.on("error", (error: Error) => {
        clearTimeout(timer);
        resolvePromise({ data: `Error: ${error.message}` });
      });
    });
  },
});
