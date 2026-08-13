









import { spawn } from "child_process";
import { resolve } from "path";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { POWERSHELL_TOOL_NAME, DESCRIPTION } from "./prompt.js";



const PowerShellInputSchema = z.object({
  command: z.string().describe(
    "The PowerShell command to run",
  ),
  timeout: z.number().optional().describe(
    "Optional timeout in milliseconds (up to 600000ms / 10 minutes). Default is 120000ms (2 minutes).",
  ),
});



const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT_BYTES = 50_000;


function resolvePowerShellExecutable(): string {
  
  
  
  if (process.platform === "win32") {
    try {
      const { spawnSync } = require("child_process");
      const pwsh = spawnSync("where", ["pwsh"], { encoding: "utf8" });
      if (pwsh.status === 0 && pwsh.stdout.trim().length > 0) {
        return "pwsh";
      }
    } catch {
      
    }
    return "powershell";
  }
  
  return "pwsh";
}



export const PowerShellTool = buildTool({
  name: POWERSHELL_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: PowerShellInputSchema,

  userFacingName: (_input) => "PowerShell",

  
  
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
