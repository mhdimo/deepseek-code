// LSTool — list directory contents with icons
//
// Shows files and subdirectories with type icons. Filters hidden files
// and node_modules. Sorts directories first, then alphabetically.

import { readdir } from "fs/promises";
import { relative, resolve } from "path";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { resolvePath } from "../../utils/toolUtils.js";
import { LS_TOOL_NAME, DESCRIPTION } from "./prompt.js";

// ─── Input schema ────────────────────────────────────────────────────────────

const LSInputSchema = z.object({
  path: z.string().optional().describe(
    "The absolute path to the directory to list (defaults to the current working directory)",
  ),
});

// ─── Tool definition ─────────────────────────────────────────────────────────

export const LSTool = buildTool({
  name: LS_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: LSInputSchema,

  userFacingName: (input) => {
    const path = input.path ?? ".";
    return `LS ${path}`;
  },

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
    const fullPath = resolvePath(context.workingDir, input.path);
    const cwd = resolve(context.workingDir);

    try {
      const entries = await readdir(fullPath, { withFileTypes: true });

      // Filter hidden files and node_modules
      const filtered = entries
        .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      const lines = filtered.map((e) => {
        const icon = e.isDirectory() ? "\uD83D\uDCC1" : "\uD83D\uDCC4";
        return `${icon} ${e.name}${e.isDirectory() ? "/" : ""}`;
      });

      const header = `${relative(cwd, fullPath) || "."}/`;
      if (lines.length === 0) {
        return { data: `${header}\n(empty directory)` };
      }

      return { data: `${header}\n${lines.join("\n")}` };
    } catch (error) {
      return { data: `Error listing directory: ${(error as Error).message}` };
    }
  },
});
