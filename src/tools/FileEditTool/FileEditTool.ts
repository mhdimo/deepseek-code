




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
import {
  editGuard,
  recordKnownState,
  statForGuard,
  EDIT_MESSAGES,
} from "../../services/readState.js";
import { syncEditedFile } from "../../services/lsp/editedFile.js";
import {
  captureDiagnosticsBaseline,
  collectNewDiagnostics,
  formatNewDiagnostics,
} from "../../services/lsp/editDiagnostics.js";
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
  requiredPermission: "allowWrite",
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

  /**
   * The read-before-edit guard: refuse an edit the model is not in a position
   * to make, and say which of the four reasons applies, before the user is
   * asked to approve anything.
   *
   * The whole file is read here as well as in `call` — deliberately, and for
   * the same reason the reference does it: the stale check is a *content*
   * comparison, not an mtime comparison (a formatter that changed nothing, a
   * `touch`, a sync client all move the mtime), and the file has to be in hand
   * to make it. It is one read of a file the tool is about to rewrite.
   */
  validateInput: async (input, context) => {
    const fullPath = resolvePath(context.workingDir, input.file_path);
    const modifiedMs = await statForGuard(fullPath);
    const content = modifiedMs === null ? null : await readFile(fullPath, "utf-8");

    const verdict = editGuard({
      oldString: input.old_string,
      newString: input.new_string,
      read: context.readFileState?.get(fullPath),
      modifiedMs,
      content,
    });

    return verdict.ok ? { result: true } : { result: false, message: verdict.message };
  },

  checkPermissions: async (input, context) => {
    const fullPath = resolvePath(context.workingDir, input.file_path);
    const relPath = relativePath(context.workingDir, fullPath);

    // Lazy: the Edit dialog renders its own hunk diff from the input;
    // auto-approve/headless modes never render a prompt, so the string
    // diff below only runs if something actually displays it.
    const preview = () => [
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

      // Both are settled in `validateInput` too, and both are restated here
      // because `call` is reachable without it (a test, a future caller) and
      // the same mistake must not be silent on one path and fatal on the
      // other. The strings come from readState.ts so they cannot drift.
      if (!old_string) {
        return { data: `Error: ${EDIT_MESSAGES.empty}` };
      }

      if (old_string === new_string) {
        return { data: `Error: ${EDIT_MESSAGES.unchanged}` };
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

      // What the language server says about the file as it stands, taken while
      // it still stands that way. Without it the server's next report — which
      // covers the whole file, including everything already wrong with it —
      // would be handed back as damage this edit did. Costs nothing when no
      // server is running, which is the usual case.
      const diagnosticsBaseline = await captureDiagnosticsBaseline(fullPath, content);

      await writeFile(fullPath, newContent, "utf-8");

      // The model has now seen this file as it stands. Without recording it,
      // the next edit in the same turn would be refused as "not read" — or, if
      // the entry were left as it was, as "modified since read".
      await recordKnownState(context.readFileState, fullPath, newContent);

      // A language server that is running for this file is holding the text
      // from before the edit. Told nothing, it answers every later question —
      // definition, references, hover — from a file that no longer exists.
      await syncEditedFile(fullPath, newContent);

      // The other half of the loop: the server has just been told what the
      // file now says, so its next report is about the text this edit wrote.
      // Only what that report adds goes back to the model.
      const findings = await collectNewDiagnostics(fullPath, diagnosticsBaseline);

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
        formatNewDiagnostics(findings),
      ]
        .filter((part): part is string => part !== null)
        .join("\n");

      return { data: result };
    } catch (error) {
      return { data: `Error editing file: ${(error as Error).message}` };
    }
  },
});
