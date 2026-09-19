




import { readFile, writeFile } from "fs/promises";
import { readFileSync } from "fs";
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
import {
  writeGuard,
  recordKnownState,
  statForGuard,
} from "../../services/readState.js";
import { syncEditedFile } from "../../services/lsp/editedFile.js";
import {
  captureDiagnosticsBaseline,
  collectNewDiagnostics,
  formatNewDiagnostics,
} from "../../services/lsp/editDiagnostics.js";
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
  requiredPermission: "allowWrite",
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

  /**
   * A Write replaces whatever is there, so it may not be aimed at a file the
   * model has not looked at — the one op that can destroy content the model
   * never knew existed. Creating a file stays allowed: there is nothing to
   * have read.
   */
  validateInput: async (input, context) => {
    const fullPath = resolvePath(context.workingDir, input.file_path);
    const verdict = writeGuard({
      read: context.readFileState?.get(fullPath),
      modifiedMs: await statForGuard(fullPath),
    });

    return verdict.ok ? { result: true } : { result: false, message: verdict.message };
  },

  checkPermissions: async (input, context) => {
    const fullPath = resolvePath(context.workingDir, input.file_path);
    const relPath = relativePath(context.workingDir, fullPath);

    // LAZY preview: the permission dialog renders its own old-vs-new diff
    // from `input` (FileWritePermissionRequest), so this description is
    // never materialized in the TUI — and headless/auto-approve modes never
    // render any prompt. The file read + full-content diff used to run on
    // EVERY Write (twice: here and in call), even when never shown.
    const preview = () => {
      let previousContent = "";
      let exists = false;
      try {
        previousContent = readFileSync(fullPath, "utf-8");
        exists = true;
      } catch {
        exists = false;
      }
      return [
        `Write ${relPath}`,
        exists ? "Mode: overwrite existing file" : "Mode: create new file",
        "",
        exists ? "Diff preview:" : "Content preview:",
        exists
          ? previewRawBlock(buildSimpleDiffPreview(previousContent, input.content), 60, 1200)
          : asAddedLines(input.content, 20),
      ].join("\n");
    };

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

    // Same reason as Edit, and the same caveat: this is only the pre-change
    // state, so it is only taken for a file that has one. A brand-new file has
    // nothing to regress from.
    const diagnosticsBaseline = exists
      ? await captureDiagnosticsBaseline(fullPath, previousContent)
      : [];

    try {
      await ensureDir(fullPath);
      await writeFile(fullPath, content, "utf-8");

      // The model knows what it just wrote, so the file counts as read. Left
      // unrecorded, the next per-tool check would refuse a Write the model
      // itself just made — the registry has to move with the file.
      await recordKnownState(context.readFileState, fullPath, content);

      // Same reason as Edit: a running server still holds the old text, and
      // a Write is the edit that invalidates the most of it at once.
      await syncEditedFile(fullPath, content);

      const findings = await collectNewDiagnostics(fullPath, diagnosticsBaseline);

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
        formatNewDiagnostics(findings),
      ]
        .filter((part): part is string => part !== null)
        .join("\n");

      return { data: result };
    } catch (error) {
      return { data: `Error writing file: ${(error as Error).message}` };
    }
  },
});
