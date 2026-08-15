/**
 * Patch generation for display (port of Claude Code's utils/diff.ts).
 *
 * getPatchForDisplay runs the edit against the file contents and returns
 * real structured hunks (line numbers relative to the file) for the
 * permission dialogs and tool-result diffs.
 */

import { type StructuredPatchHunk, structuredPatch } from "diff";

export const CONTEXT_LINES = 3;
export const DIFF_TIMEOUT_MS = 5_000;

export interface FileEditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * Shifts hunk line numbers by offset. Use when getPatchForDisplay received
 * a slice of the file rather than the whole file.
 */
export function adjustHunkLineNumbers(
  hunks: StructuredPatchHunk[],
  offset: number,
): StructuredPatchHunk[] {
  if (offset === 0) return hunks;
  return hunks.map((h) => ({
    ...h,
    oldStart: h.oldStart + offset,
    newStart: h.newStart + offset,
  }));
}

// For some reason, & confuses the diff library, so we replace it with a token,
// then substitute it back in after the diff is computed.
const AMPERSAND_TOKEN = "<<:AMPERSAND_TOKEN:>>";
const DOLLAR_TOKEN = "<<:DOLLAR_TOKEN:>>";

function escapeForDiff(s: string): string {
  return s.replaceAll("&", AMPERSAND_TOKEN).replaceAll("$", DOLLAR_TOKEN);
}

function unescapeFromDiff(s: string): string {
  return s.replaceAll(AMPERSAND_TOKEN, "&").replaceAll(DOLLAR_TOKEN, "$");
}

/** Convert leading tabs to spaces for display (tab expansion, 2 per tab). */
export function convertLeadingTabsToSpaces(content: string): string {
  // The /gm regex scans every line even on no-match; skip it entirely
  // for the common tab-free case.
  if (!content.includes("\t")) return content;
  return content.replace(/^\t+/gm, (_) => "  ".repeat(_.length));
}

/** Build a patch from two full contents (e.g. old vs new file). */
export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace = false,
  singleHunk = false,
}: {
  filePath: string;
  oldContent: string;
  newContent: string;
  ignoreWhitespace?: boolean;
  singleHunk?: boolean;
}): StructuredPatchHunk[] {
  const result = structuredPatch(
    filePath,
    filePath,
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    undefined,
    undefined,
    {
      ignoreWhitespace,
      context: singleHunk ? 100_000 : CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    },
  );
  if (!result) {
    return [];
  }
  return result.hunks.map((_) => ({
    ..._,
    lines: _.lines.map(unescapeFromDiff),
  }));
}

/**
 * Get a patch for display with edits applied.
 * NOTE: This function will return the diff with all leading tabs
 * rendered as spaces for display.
 */
export function getPatchForDisplay({
  filePath,
  fileContents,
  edits,
  ignoreWhitespace = false,
}: {
  filePath: string;
  fileContents: string;
  edits: FileEditSpec[];
  ignoreWhitespace?: boolean;
}): StructuredPatchHunk[] {
  const preparedFileContents = escapeForDiff(
    convertLeadingTabsToSpaces(fileContents),
  );
  const result = structuredPatch(
    filePath,
    filePath,
    preparedFileContents,
    edits.reduce((p, edit) => {
      const { old_string, new_string } = edit;
      const replace_all = edit.replace_all ?? false;
      const escapedOldString = escapeForDiff(
        convertLeadingTabsToSpaces(old_string),
      );
      const escapedNewString = escapeForDiff(
        convertLeadingTabsToSpaces(new_string),
      );

      if (replace_all) {
        return p.replaceAll(escapedOldString, () => escapedNewString);
      } else {
        return p.replace(escapedOldString, () => escapedNewString);
      }
    }, preparedFileContents),
    undefined,
    undefined,
    {
      context: CONTEXT_LINES,
      ignoreWhitespace,
      timeout: DIFF_TIMEOUT_MS,
    },
  );
  if (!result) {
    return [];
  }
  return result.hunks.map((_) => ({
    ..._,
    lines: _.lines.map(unescapeFromDiff),
  }));
}

/** Serialize hunks into unified-diff text (the format tool results embed). */
export function hunksToDiffText(hunks: StructuredPatchHunk[]): string {
  return hunks
    .map(
      (h) =>
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n` +
        h.lines.join("\n"),
    )
    .join("\n");
}
