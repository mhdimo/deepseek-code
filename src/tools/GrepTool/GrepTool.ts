// GrepTool — search for text patterns in files
//
// Uses grep -rn with exclusions for node_modules, .git, and dist.
// Returns matching lines with file paths and line numbers.

import { spawn } from "child_process";
import { relative, resolve } from "path";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { resolvePath } from "../../utils/toolUtils.js";
import { GREP_TOOL_NAME, DESCRIPTION } from "./prompt.js";

// ─── Input schema ────────────────────────────────────────────────────────────

const GrepInputSchema = z.object({
  pattern: z.string().describe(
    "The regular expression pattern to search for in file contents",
  ),
  path: z.string().optional().describe(
    "File or directory to search in. Defaults to current working directory.",
  ),
  include: z.string().optional().describe(
    'File glob to filter by (e.g. "*.js" or "*.{ts,tsx}")',
  ),
});

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_MATCH_LINES = 100;

// ─── Tool definition ─────────────────────────────────────────────────────────

export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: GrepInputSchema,

  userFacingName: (_input) => "Grep",

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
    const { pattern, include } = input;
    const dir = resolvePath(context.workingDir, input.path);
    const cwd = resolve(context.workingDir);

    try {
      const args = [
        "-rn",
        "--color=never",
        "-E",
        pattern,
        dir,
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
      ];
      if (include) {
        args.push(`--include=${include}`);
      }

      return new Promise<{ data: string }>((resolvePromise) => {
        const child = spawn("grep", args, {
          stdio: ["ignore", "pipe", "pipe"],
        });

        let out = "";
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString();
        });

        child.on("close", () => {
          const lines = out.trim().split("\n").filter(Boolean);
          if (lines.length === 0) {
            resolvePromise({ data: "No matches found." });
            return;
          }

          const results = lines.slice(0, MAX_MATCH_LINES).map((l) => {
            const colonIdx = l.indexOf(":");
            if (colonIdx === -1) return l;
            const filePart = l.slice(0, colonIdx);
            const rest = l.slice(colonIdx + 1);
            return `${relative(cwd, filePart)}:${rest}`;
          }).join("\n");

          if (lines.length > MAX_MATCH_LINES) {
            resolvePromise({
              data: `${results}\n... (${lines.length - MAX_MATCH_LINES} more matches)`,
            });
          } else {
            resolvePromise({ data: results });
          }
        });

        child.on("error", () => {
          resolvePromise({ data: "Error: grep command not available" });
        });
      });
    } catch (error) {
      return { data: `Error: ${(error as Error).message}` };
    }
  },
});
