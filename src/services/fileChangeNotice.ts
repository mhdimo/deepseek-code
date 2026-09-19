/**
 * A file the model read, changed on disk by someone else — said out loud.
 *
 * The read-before-edit guard (`services/readState.ts`) refuses to *act* on
 * content the model has not seen. This is the other half of the same problem:
 * nothing in the model's context changes when the user edits a file in their
 * editor or a formatter rewrites it, so a turn that read the file ten minutes
 * ago goes on reasoning about text that is no longer there — and the fix it
 * builds stops being a fix without anything saying so. The reference injects
 * the same notice (its `edited_text_file` attachment, capped at 8KB for the
 * same reason this is capped).
 *
 * It travels the channel background-task notifications already use: the engine
 * owns history, so a user turn ahead of the prompt is the only way in — see
 * `services/tasks/notifications.ts` for why that is safe on the wire.
 *
 * What the model gets is the *diff*, not the file: it can read the file for
 * itself, and the point is to tell it that its copy is stale, not to be a
 * second, worse copy. Files it only ever saw part of (a ranged read, a
 * notebook rendering) are named without one — a diff taken against something
 * the model never had would be a lie in diff's clothing.
 */

import { readFile } from "fs/promises";
import { getPatchFromContents, hunksToDiffText } from "../utils/diff.js";
import { statForGuard, type ReadStateStore } from "./readState.js";

export interface FileChange {
  path: string;
  /** Unified-diff hunks between what the model was shown and what is on disk
   *  now. Empty when the model never saw the whole file. */
  snippet: string;
}

/** Per turn, and per file. A formatter that rewrote the whole tree is one
 *  notice, not fifty: what is left over is reported on the next turn, and the
 *  model is told how many arrived rather than being handed an unbounded turn. */
export const MAX_CHANGED_FILES = 5;

/** The reference's cap, in characters. A format-on-save of a large file used
 *  to inject the whole thing every turn. */
export const MAX_SNIPPET_CHARS = 8192;

/**
 * Every file the model read that has changed underneath it, and the entry
 * brought up to date so it is reported once rather than every turn.
 *
 * The entry keeps the content the model actually read — only its timestamp
 * moves. That is what makes this safe to tell the model about: a diff in a
 * notice is not a read, so the guard still refuses an edit with "modified
 * since read" until the file is read again.
 */
export async function collectFileChanges(store: ReadStateStore): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  for (const path of store.paths()) {
    if (changes.length >= MAX_CHANGED_FILES) break;
    const entry = store.get(path);
    if (!entry) continue;

    try {
      const modifiedMs = await statForGuard(path);
      if (modifiedMs === null) {
        // Gone. Edit's own "File does not exist" says it better than this
        // could, and an entry nothing can ever match is one more stat per turn
        // for the life of the session.
        store.forget(path);
        continue;
      }
      if (modifiedMs <= entry.timestamp) continue;

      const current = await readFile(path, "utf-8");
      if (current === entry.content) {
        // The clock moved and the bytes did not: a `touch`, a formatter that
        // found nothing to do, a sync client. Not news — but record the new
        // mtime, or every later turn looks again.
        store.record(path, { ...entry, timestamp: modifiedMs });
        continue;
      }

      changes.push({
        path,
        snippet: entry.isPartialView ? "" : boundedDiff(path, entry.content, current),
      });
      store.record(path, { ...entry, timestamp: modifiedMs });
    } catch {
      // A stat or a read that fails for any reason but absence — a permission
      // change, a file swapping under us mid-read — is not worth failing the
      // turn for. The entry stays as it was and the file is reconsidered next
      // turn; if it stays unreadable, `Read` will say why when the model asks.
    }
  }

  return changes;
}

/**
 * What the model is told when the diff was abandoned rather than truncated.
 * The two are not the same failure and must not read the same: a truncated
 * diff still shows the beginning of the change, whereas an abandoned one
 * shows nothing, and an empty snippet has its own meaning further down
 * (a file the model only ever read in part) that this must not borrow.
 */
export const DIFF_ABANDONED =
  "(this file changed too much to diff here — read it again before editing)";

export function boundedDiff(
  path: string,
  before: string,
  after: string,
  timeoutMs?: number,
): string {
  // `diff` gives up when it overruns its budget and hands back undefined. On
  // a large rewrite that is reachable in practice, and it arrives here as an
  // empty patch — the same shape as "nothing to say" — so it has to be
  // caught at the call that knows the difference.
  let abandoned = false;
  const text = hunksToDiffText(
    getPatchFromContents({
      filePath: path,
      oldContent: before,
      newContent: after,
      timeoutMs,
      onTimeout: () => {
        abandoned = true;
      },
    }),
  );
  if (abandoned) return DIFF_ABANDONED;
  return text.length <= MAX_SNIPPET_CHARS
    ? text
    : text.slice(0, MAX_SNIPPET_CHARS) + "\n… (diff truncated — read the file for the rest)";
}

/** Paths go inside an XML attribute, and a path may legally contain a quote. */
function attr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The text handed to the engine. Empty when there is nothing to say — callers
 *  check before appending a turn, exactly as they do for task notifications. */
export function formatFileChanges(changes: FileChange[]): string {
  if (changes.length === 0) return "";

  const heading =
    changes.length === 1
      ? "A file you read has changed on disk since you read it. This is a system notification, not a message from the user:"
      : `${changes.length} files you read have changed on disk since you read them. This is a system notification, not a message from the user:`;

  const blocks = changes.map((change) =>
    change.snippet
      ? `<file-changed path="${attr(change.path)}">\n${change.snippet}\n</file-changed>`
      : `<file-changed path="${attr(change.path)}">\n` +
        `(you only read part of this file, so no diff is shown)\n</file-changed>`,
  );

  const trailer =
    "What you have in context for these files is out of date — read a file again before editing it.";

  return `${heading}\n\n${blocks.join("\n\n")}\n\n${trailer}`;
}
