




import { readFile, writeFile } from "fs/promises";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import {
  resolvePath,
  relativePath,
  buildSimpleDiffPreview,
  previewRawBlock,
} from "../../utils/toolUtils.js";
import { getPatchForDisplay, hunksToDiffText } from "../../utils/diff.js";
import { FILE_EDIT_TOOL_NAME, DESCRIPTION } from "./prompt.js";



const FileEditInputSchema = z.object({
  file_path: z.string().describe(
    "The absolute path to the file to modify",
  ),
  old_string: z.string().describe(
    "The text to replace",
  ),
  new_string: z.string().describe(
    "The text to replace it with (must be different from old_string)",
  ),
  replace_all: z.boolean().optional().describe(
    "Replace all occurrences of old_string (default false)",
  ),
});



export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: FileEditInputSchema,

  userFacingName: (input) => {
    const path = input.file_path ?? "";
    const lastPart = path.split("/").pop() ?? path;
    return `Edit ${lastPart}`;
  },

  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  maxResultSizeChars: 100_000,

  checkPermissions: async (input, context) => {
    if (!context.permissions.allowWrite) {
      return { approved: false, feedback: "Write permission denied for this agent." };
    }

    const fullPath = resolvePath(context.workingDir, input.file_path);
    const relPath = relativePath(context.workingDir, fullPath);

    const preview = [
      `Edit ${relPath}`,
      "",
      "Diff preview:",
      previewRawBlock(
        buildSimpleDiffPreview(input.old_string, input.new_string),
        60,
        1200,
      ),
    ].join("\n");

    return context.requestPermission("Edit", preview, input);
  },

  call: async (input, context) => {
    const { file_path, old_string, new_string, replace_all } = input;
    const fullPath = resolvePath(context.workingDir, file_path);
    const relPath = relativePath(context.workingDir, fullPath);

    try {
      const content = await readFile(fullPath, "utf-8");

      if (!old_string) {
        return { data: "Error: old_string is empty or missing." };
      }

      if (!content.includes(old_string)) {
        return {
          data: `Error: old_string not found in ${relPath}. Make sure it matches exactly.`,
        };
      }

      const replaceAll = replace_all ?? false;

      if (!replaceAll) {
        const occurrences = content.split(old_string).length - 1;
        if (occurrences > 1) {
          return {
            data: `Error: old_string found ${occurrences} times in ${relPath}. Add more surrounding context to match uniquely, or use replace_all to replace all occurrences.`,
          };
        }
      }

      const newContent = replaceAll
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string);

      await writeFile(fullPath, newContent, "utf-8");

      // Real hunks against the actual file (line numbers + context), the
      // way Claude Code renders its tool-result diffs.
      const hunks = getPatchForDisplay({
        filePath: relPath,
        fileContents: content,
        edits: [{ old_string, new_string, replace_all: replaceAll }],
      });
      const result = [
        `Edited ${relPath}`,
        "",
        "Diff preview:",
        hunksToDiffText(hunks),
      ].join("\n");

      return { data: result };
    } catch (error) {
      return { data: `Error editing file: ${(error as Error).message}` };
    }
  },
});
