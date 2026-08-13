




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
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString();
        });

        child.on("close", () => {
          const results = out
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((p) => relative(cwd, p))
            .slice(0, MAX_RESULTS);

          if (results.length === 0) {
            resolvePromise({ data: "No files matched the pattern." });
          } else {
            resolvePromise({ data: results.join("\n") });
          }
        });

        child.on("error", () => {
          resolvePromise({ data: "Error: find command not available" });
        });
      });
    } catch (error) {
      return { data: `Error: ${(error as Error).message}` };
    }
  },
});
