




import { spawn } from "child_process";
import { relative, resolve } from "path";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { resolvePath } from "../../utils/toolUtils.js";
import { GLOB_TOOL_NAME, DESCRIPTION } from "./prompt.js";



const GlobInputSchema = z.object({
  pattern: z.string().describe(
    'The glob pattern to match files against (e.g. "**/*.ts" or "src/**/*.tsx")',
  ),
  path: z.string().optional().describe(
    "The directory to search in. Defaults to current working directory.",
  ),
});



const MAX_RESULTS = 200;



export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: GlobInputSchema,

  userFacingName: (_input) => "Glob",

  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  maxResultSizeChars: 100_000,

  checkPermissions: async (_input, context) => {
    if (!context.permissions.allowRead) {
      return { approved: false, feedback: "Read permission denied for this agent." };
    }
    return { approved: true };
  },

  call: async (input, context) => {
    const { pattern } = input;
    const dir = resolvePath(context.workingDir, input.path);
    const cwd = resolve(context.workingDir);

    try {
      return new Promise<{ data: string }>((resolvePromise) => {
        const child = spawn(
          "find",
          [
            dir,
            "-name",
            pattern,
            "-not",
            "-path",
            "*/node_modules/*",
            "-not",
            "-path",
            "*/.git/*",
            "-type",
            "f",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );

        let out = "";
        let lines = 0;
        let settled = false;
        const settle = (data: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolvePromise({ data });
        };

        child.stdout.on("data", (d: Buffer) => {
          const chunk = d.toString();
          out += chunk;
          lines += chunk.split("\n").length - 1;
          // Early stop: we only keep MAX_RESULTS — don't let find traverse
          // the whole tree (and buffer unbounded output) for a huge match set.
          if (lines >= MAX_RESULTS) {
            child.kill("SIGTERM");
            settle(out.trim().split("\n").filter(Boolean).slice(0, MAX_RESULTS).map((p) => relative(cwd, p)).join("\n") || "No files matched the pattern.");
          }
        });

        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          settle("Error: glob timed out");
        }, 30_000);

        const abortHandler = () => settle("Aborted/Cancelled by user");
        context.abortController?.signal.addEventListener("abort", abortHandler);

        child.on("close", () => {
          context.abortController?.signal.removeEventListener("abort", abortHandler);
          if (settled) return;
          const results = out
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((p) => relative(cwd, p))
            .slice(0, MAX_RESULTS);

          if (results.length === 0) {
            settle("No files matched the pattern.");
          } else {
            settle(results.join("\n"));
          }
        });

        child.on("error", () => {
          context.abortController?.signal.removeEventListener("abort", abortHandler);
          settle("Error: find command not available");
        });
      });
    } catch (error) {
      return { data: `Error: ${(error as Error).message}` };
    }
  },
});
