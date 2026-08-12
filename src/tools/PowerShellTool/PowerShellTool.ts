// PowerShellTool — execute PowerShell commands on Windows
//
// A Bash-equivalent tool that runs commands via powershell.exe (Windows
// PowerShell 5.1) or pwsh (PowerShell 7+) when available. Mirrors BashTool's
// structure: spawn with a configurable timeout, capture stdout/stderr,
// truncate output at 50KB, request Execute permission with a command preview.
//
// isEnabled() returns true only on Windows (process.platform === "win32") so
// the tool is hidden from the model on macOS/Linux where BashTool is used.

import { spawn } from "child_process";
import { resolve } from "path";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { POWERSHELL_TOOL_NAME, DESCRIPTION } from "./prompt.js";

// ─── Input schema ────────────────────────────────────────────────────────────

const PowerShellInputSchema = z.object({
  command: z.string().describe(
    "The PowerShell command to run",
  ),
  timeout: z.number().optional().describe(
    "Optional timeout in milliseconds (up to 600000ms / 10 minutes). Default is 120000ms (2 minutes).",
  ),
});

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT_BYTES = 50_000;

/**
 * Resolve which PowerShell executable to invoke. Prefer PowerShell 7+ (pwsh)
 * if it is on PATH, otherwise fall back to Windows PowerShell 5.1
 * (powershell.exe). Both accept the same -NoProfile -NonInteractive -Command
 * argument shape used below.
 *
 * Detection is best-effort: if neither is found we still return "powershell"
 * so spawn surfaces a clear "command not found" error to the model rather than
 * failing the whole tool assembly.
 */
function resolvePowerShellExecutable(): string {
  // On Windows, `where` is the equivalent of `which`. Keep this synchronous and
  // cheap — it only runs once per tool call, and only on Windows (isEnabled()
  // gates the whole tool off-platform).
  if (process.platform === "win32") {
    try {
      const { spawnSync } = require("child_process");
      const pwsh = spawnSync("where", ["pwsh"], { encoding: "utf8" });
      if (pwsh.status === 0 && pwsh.stdout.trim().length > 0) {
        return "pwsh";
      }
    } catch {
      // Fall through to powershell.exe default.
    }
    return "powershell";
  }
  // Off Windows the tool is disabled, but return a sensible default anyway.
  return "pwsh";
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const PowerShellTool = buildTool({
  name: POWERSHELL_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: PowerShellInputSchema,

  userFacingName: (_input) => "PowerShell",

  // Only offer the tool on Windows. On macOS/Linux the BashTool covers shell
  // execution and PowerShell is typically not installed.
  isEnabled: () => process.platform === "win32",
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  maxResultSizeChars: 100_000,

  checkPermissions: async (input, context) => {
    if (!context.permissions.allowExecute) {
      return { approved: false, feedback: "Execute permission denied for this agent." };
    }

    return context.requestPermission("PowerShell", input.command);
  },

  call: async (input, context) => {
    const { command } = input;
    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const cwd = resolve(context.workingDir);
    const exe = resolvePowerShellExecutable();

    return new Promise<{ data: string }>((resolvePromise) => {
      // -NoProfile: don't load the user profile (faster, deterministic).
      // -NonInteractive: never pop a prompt that would hang the tool.
      // -Command: treat the next arg as the command line to execute.
      const child = spawn(
        exe,
        ["-NoProfile", "-NonInteractive", "-Command", command],
        {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, FORCE_COLOR: "0" },
        },
      );

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (data: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ data });
      };

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        if (context.onToolOutput) {
          context.onToolOutput("PowerShell", chunk);
        }
        if (stdout.length > MAX_OUTPUT_BYTES) {
          child.kill();
          finish(`(output truncated at 50KB)\n${stdout.slice(0, MAX_OUTPUT_BYTES)}`);
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        if (context.onToolOutput) {
          context.onToolOutput("PowerShell", chunk);
        }
      });

      const timer = setTimeout(() => {
        child.kill();
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
        finish(`Command timed out after ${timeout}ms\n${output}`);
      }, timeout);

      child.on("close", (code: number | null) => {
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
        if (code === 0) {
          finish(output || "(no output)");
        } else {
          finish(`Exit code ${code}\n${output}`);
        }
      });

      child.on("error", (error: Error) => {
        finish(`Error: ${error.message}`);
      });
    });
  },
});
