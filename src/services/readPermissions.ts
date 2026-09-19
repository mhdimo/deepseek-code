/**
 * Reads and searches outside the working directory.
 *
 * The ported read dialogs ("Allow read access to …?") had no caller: no read
 * tool ever asked, so `Read /etc/hosts`, `Grep … path: ~/.ssh` and `Glob …
 * path: /` ran silently and the session's working directory was descriptive
 * rather than a boundary. Upstream's read permission check ends the same way
 * for all of them — inside a working directory allows, outside it asks — so
 * that decision lives here, once, and the three tools return what the prompt
 * answered.
 *
 * The tool name travels with the request because the dialog dispatches on it.
 * Glob and Grep ask under their registered names and reach their read dialogs;
 * Read asks under "Read", which the dispatcher knows as "FileRead" — so a Read
 * prompt currently renders the generic dialog until that one name is
 * reconciled (see PermissionPrompt's `toolName === "FileRead"` branch).
 */

import { realpathSync } from "fs";
import type { PermissionCallback, PermissionDecision } from "../Tool.js";
import { resolvePath } from "../utils/toolUtils.js";
import { pathInWorkingPath } from "./permissions.js";

/** The input field each read tool resolves its search root from, in the order
 *  the tool itself resolves it (Glob/Grep fall back to the working directory
 *  when none is given, which needs no asking). `file_path` is accepted as a
 *  second spelling because the permission dialogs look for it. */
const READ_TARGET_FIELDS: Record<string, readonly string[]> = {
  Read: ["file_path"],
  Glob: ["path", "file_path"],
  Grep: ["path", "file_path"],
};

/**
 * The path a read/search tool will actually touch, resolved the way the tool
 * resolves it. `null` when the input names no path at all: the tool then works
 * from the working directory, and there is nothing outside it to ask about.
 */
export function readTargetPath(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
): string | null {
  const fields = READ_TARGET_FIELDS[toolName];
  if (!fields) return null;
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) return resolvePath(workingDir, value);
  }
  return null;
}

function realPathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * True when reading `path` reaches outside `workingDir`.
 *
 * Both spellings have to be inside: the path as written, and the one the
 * filesystem ends up at. Without the second half a symlink parked in the
 * project is a standing invitation to read anywhere — the approval would be
 * given in the project's name while the bytes come from outside it. Failure to
 * resolve either side (a path the tool is about to report as missing, a
 * working directory that has been deleted) falls back to the literal answer
 * rather than inventing a prompt.
 */
export function isOutsideWorkingDir(path: string, workingDir: string): boolean {
  if (!pathInWorkingPath(path, workingDir)) return true;
  const realDir = realPathOrNull(workingDir);
  if (realDir === null) return false;
  const realTarget = realPathOrNull(path);
  if (realTarget === null) return false;
  return !pathInWorkingPath(realTarget, realDir);
}

export interface ReadAccessContext {
  workingDir: string;
  getPlanMode(): boolean;
  requestPermission: PermissionCallback;
}

/**
 * The `checkPermissions` body for the read/search tools.
 *
 * Order matters twice. The path check comes first because the common case — a
 * read inside the project — must not reach the prompt machinery at all. Plan
 * mode comes second: it is read-only, reading is the whole of what it permits,
 * and the UI refuses *every* permission request in that mode before it
 * prompts, so asking there would turn an exploration into a denial.
 */
export async function checkReadAccess(
  toolName: string,
  input: Record<string, unknown>,
  context: ReadAccessContext,
): Promise<PermissionDecision> {
  const target = readTargetPath(toolName, input, context.workingDir);
  if (target === null || !isOutsideWorkingDir(target, context.workingDir)) {
    return { approved: true };
  }
  if (context.getPlanMode()) return { approved: true };
  // The first line is what a dialog with no read-specific rendering puts in
  // its `Tool(args)` header; the second is why the question is being asked,
  // which is not obvious from the path alone.
  const description = `${target}\nOutside the working directory (${context.workingDir}).`;
  return context.requestPermission(toolName, description, input);
}
