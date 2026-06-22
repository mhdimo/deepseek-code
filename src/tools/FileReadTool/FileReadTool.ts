// FileReadTool — reads file contents with line numbers
//
// Uses the shared formatFileContent utility from utils.ts for consistent
// line-number formatting across the codebase.

import { readFile } from "fs/promises";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { resolvePath, formatFileContent } from "../../utils/toolUtils.js";
import { FILE_READ_TOOL_NAME, DESCRIPTION } from "./prompt.js";

// ─── Input schema ────────────────────────────────────────────────────────────

const FileReadInputSchema = z.object({
  file_path: z.string().describe(
    "The absolute path to the file to read",
  ),
  offset: z.number().optional().describe(
    "The line number to start reading from. Only provide if the file is too large to read at once",
  ),
  limit: z.number().optional().describe(
    "The number of lines to read. Only provide if the file is too large to read at once",
  ),
});

// ─── Tool definition ─────────────────────────────────────────────────────────

export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: FileReadInputSchema,

  userFacingName: (input) => {
    const path = input.file_path ?? "";
    const lastPart = path.split("/").pop() ?? path;
    return `Read ${lastPart}`;
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
    const { file_path, offset, limit } = input;
    const fullPath = resolvePath(context.workingDir, file_path);

    try {
      const content = await readFile(fullPath, "utf-8");

      // If offset or limit specified, use formatFileContent for slicing
      if (offset !== undefined || limit !== undefined) {
        const result = formatFileContent(content, offset ?? 0, limit);
        return { data: result || "(empty file)" };
      }

      // Default: read entire file with line numbers (up to 2000 lines)
      const lines = content.split("\n");
      const end = Math.min(lines.length, 2000);
      const result = lines
        .slice(0, end)
        .map((line, i) => `${String(i + 1).padStart(4)}\u2502${line}`)
        .join("\n");

      if (lines.length > 2000) {
        return { data: `${result}\n... (${lines.length - 2000} more lines)` };
      }
      return { data: result || "(empty file)" };
    } catch (error) {
      return { data: `Error reading file: ${(error as Error).message}` };
    }
  },
});
