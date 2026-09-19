/**
 * Telling a running language server about a file the agent just rewrote.
 *
 * `changeFile` has existed on the manager since the LSP client was written and
 * had no caller: nothing in the app ever reported a write back to the server.
 * The consequence is quiet and specific. A server that was given a file and
 * never told it changed keeps its own copy of the old text, so every answer it
 * gives afterwards — a definition, a reference, a hover — is computed against
 * a file that no longer exists, and it is *confident* about it.
 *
 * Two rules shape this module:
 *
 * 1. It never fails the caller. The edit has already been written to disk by
 *    the time this runs; a language server that is slow, wedged, or gone must
 *    not turn a successful write into an error the model then tries to fix.
 * 2. It never starts anything. Only a server that is already running hears
 *    about the edit (`changeFile` enforces that). Starting one here would make
 *    every Write in a session spawn a process per language, on behalf of a
 *    feature the user never asked for.
 */
import { getLspServerManager } from "./manager.js";

function debugLog(message: string): void {
  if (process.env.DEEPSEEK_CODE_DEBUG === "1" || process.env.DEBUG) {
    console.error(`[lsp] ${message}`);
  }
}

/**
 * Report `content` as the current text of `filePath`, if any server cares.
 *
 * Returns whether a running server was actually told, which is what the
 * diagnostics pass keys off — there is no point waiting for diagnostics from a
 * server that was never informed the file changed.
 */
export async function syncEditedFile(filePath: string, content: string): Promise<boolean> {
  try {
    const manager = getLspServerManager();
    if (!manager) return false;

    const server = manager.getServerForFile(filePath);
    if (!server || server.state !== "running") return false;

    await manager.changeFile(filePath, content);
    return true;
  } catch (error) {
    debugLog(
      `Failed to sync ${filePath} to the language server: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
