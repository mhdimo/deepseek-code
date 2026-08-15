




import { readFile, writeFile } from "fs/promises";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import {
  resolvePath,
  relativePath,
  ensureDir,
  buildSimpleDiffPreview,
  asAddedLines,
  previewRawBlock,
} from "../../utils/toolUtils.js";
import { getPatchFromContents, hunksToDiffText } from "../../utils/diff.js";
import { FILE_WRITE_TOOL_NAME, DESCRIPTION } from "./prompt.js";



const FileWriteInputSchema = z.object({
  file_path: z.string().describe(
    "The absolute path to the file to write (must be absolute, not relative)",
  ),
  content: z.string().describe(
    "The full content to write to the file",
  ),
});



export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: FileWriteInputSchema,

  userFacingName: (input) => {
    const path = input.file_path ?? "";
    const lastPart = path.split("/").pop() ?? path;
    return `Write ${lastPart}`;
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

    
    let previousContent = "";
    let exists = false;
    try {
      previousContent = await readFile(fullPath, "utf-8");
      exists = true;
    } catch {
      exists = false;
    }

    const preview = [
      `Write ${relPath}`,
      exists ? "Mode: overwrite existing file" : "Mode: create new file",
      "",
      exists ? "Diff preview:" : "Content preview:",
      exists
        ? previewRawBlock(buildSimpleDiffPreview(previousContent, input.content), 60, 1200)
        : asAddedLines(input.content, 20),
    ].join("\n");

    return context.requestPermission("Write", preview, input);
  },

  call: async (input, context) => {
    const { file_path, content } = input;
    const fullPath = resolvePath(context.workingDir, file_path);
    const relPath = relativePath(context.workingDir, fullPath);

    
    let previousContent = "";
    let exists = false;
    try {
      previousContent = await readFile(fullPath, "utf-8");
      exists = true;
    } catch {
      exists = false;
    }

    try {
      await ensureDir(fullPath);
      await writeFile(fullPath, content, "utf-8");

      // Real hunks against the previous content for overwrites; plain
      // added-lines preview for brand-new files.
      const diffHunks = exists
        ? getPatchFromContents({ filePath: relPath, oldContent: previousContent, newContent: content })
        : null;

      const result = [
        `Wrote ${relPath} (${content.split("\n").length} lines)`,
        "",
        diffHunks && diffHunks.length > 0 ? "Diff preview:" : "Added lines:",
        diffHunks && diffHunks.length > 0 ? hunksToDiffText(diffHunks) : asAddedLines(content, 80),
      ].join("\n");

      return { data: result };
    } catch (error) {
      return { data: `Error writing file: ${(error as Error).message}` };
    }
  },
});
