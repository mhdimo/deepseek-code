
import { stat } from "fs/promises";

/**
 * What the model has actually seen on disk, and the two decisions that depend
 * on it.
 *
 * Edit and Write used to operate blind: `old_string` was matched against
 * whatever the file contained *right now*, so an edit to a file nobody had
 * read would silently rewrite text the model was guessing at, and an edit to a
 * file a linter had rewritten mid-turn would match against the new text while
 * the model reasoned about the old. The reference implementation refuses both,
 * ahead of the permission prompt — the model gets a message it can act on
 * instead of a diff the user is asked to approve.
 *
 * The registry is the same one the stale-file notice reads
 * (`services/fileChangeNotice.ts`), because "has this changed since I read it"
 * is one question, and answering it in two places is how the two answers drift.
 *
 * Storage is per `ToolUseContext`, so it dies with the session: a read from a
 * previous conversation is not evidence about this one. (See
 * `resetMemorySession` — it drops the cached session, and the store with it.)
 */

/** One file the model has been shown, and when. */
export interface ReadStateEntry {
  /** The file's `mtimeMs` as of the read, sub-millisecond digits included.
   *  Not floored to whole milliseconds: flooring is what makes two writes
   *  inside the same millisecond compare as equal. */
  timestamp: number;
  /** Exactly the bytes the model was shown — raw utf-8, the same decoding
   *  `FileReadTool` uses, so a touched-but-unchanged file can be told apart
   *  from a rewritten one without guessing at a hash. */
  content: string;
  /** The model saw a *range* of the file, or the app showed it content it had
   *  rewritten. Either way it has not seen the whole thing, and an edit needs
   *  a real read first. */
  isPartialView?: boolean;
}

export interface ReadStateStore {
  get(path: string): ReadStateEntry | undefined;
  record(path: string, entry: ReadStateEntry): void;
  /** Drop a path. For a file that is no longer there: an entry that can never
   *  match again is one the change notice would stat on every turn. */
  forget(path: string): void;
  /** Every tracked path, oldest first. */
  paths(): string[];
  readonly size: number;
}

/**
 * Bounded like the reference's cache, and for the same reason: the entry holds
 * the file's text, so an unbounded registry is a slow leak of every file the
 * session has read. 100 files is far more than a turn's worth.
 */
export const MAX_READ_STATE_ENTRIES = 100;

export function createReadState(
  maxEntries: number = MAX_READ_STATE_ENTRIES,
): ReadStateStore {
  // Insertion-ordered, so re-recording moves a path to the end and the
  // eviction below takes the least recently touched one.
  const entries = new Map<string, ReadStateEntry>();
  return {
    get: (path) => entries.get(path),
    forget: (path) => {
      entries.delete(path);
    },
    paths: () => [...entries.keys()],
    record: (path, entry) => {
      entries.delete(path);
      entries.set(path, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    get size() {
      return entries.size;
    },
  };
}

/** The messages the model reads. Exported because `call()` — the path a test
 *  or a future caller can take without the validation step — has to say the
 *  same thing, and two literals is how they drift. */
export const EDIT_MESSAGES = {
  empty:
    "old_string is empty. Provide the text to replace, or use Write to create the file.",
  unchanged:
    "No changes to make: old_string and new_string are exactly the same.",
  missing:
    "File does not exist. Check the path, or use Write to create it.",
  unread: "File has not been read yet. Read it first before writing to it.",
  partial:
    "Only part of this file has been read. Read the whole file before editing it.",
  stale:
    "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
} as const;

export const WRITE_MESSAGES = {
  unread: EDIT_MESSAGES.unread,
  partial: EDIT_MESSAGES.partial,
  stale: EDIT_MESSAGES.stale,
} as const;

export type EditGuardReason = keyof typeof EDIT_MESSAGES;

export type GuardVerdict =
  | { ok: true }
  | { ok: false; reason: EditGuardReason; message: string };

const OK: GuardVerdict = { ok: true };
const fail = (reason: EditGuardReason): GuardVerdict => ({
  ok: false,
  reason,
  message: EDIT_MESSAGES[reason],
});

export interface FileReadStateQuery {
  /** What the registry holds for this path. */
  read: ReadStateEntry | undefined;
  /** The file's mtime as `statForGuard` reports it — `null` when it does not
   *  exist, which is the whole of what Edit uses it for: staleness itself is
   *  settled by the content below. */
  modifiedMs: number | null;
  /** The file's current text. Null exactly when the file does not exist — a
   *  file that exists but cannot be read is an error the caller reports, not a
   *  verdict, so readers must let everything but ENOENT propagate. */
  content: string | null;
}

/**
 * Whether the model may edit this file, and if not, what to tell it.
 *
 * Pure on purpose: every branch here is a decision, and the I/O that feeds it
 * (stat, read, the registry lookup) lives in the tool. The ordering matters —
 * an empty `old_string` is reported as such rather than as a missing read,
 * because "read it first" sends the model to fix the wrong thing.
 */
export function editGuard(
  input: FileReadStateQuery & { oldString: string; newString: string },
): GuardVerdict {
  const { oldString, newString, read, modifiedMs, content } = input;

  // First, because it is the one failure the model can fix without touching
  // the filesystem — and the one that used to *report success*: replacing a
  // string with itself rewrote the file byte-for-byte and answered "Edited".
  if (oldString === "") return fail("empty");
  if (oldString === newString) return fail("unchanged");
  if (modifiedMs === null || content === null) return fail("missing");
  if (!read) return fail("unread");
  if (read.isPartialView) return fail("partial");

  // The comparison is against the *content*, not the mtime — the caller has
  // the file in hand, so comparing bytes answers the actual question and two
  // surprises fall out for free: `touch`, a formatter that rewrote nothing and
  // a sync client re-stat'ing a file all advance the mtime without changing
  // anything (not stale, and the model should not be sent back for a re-read
  // it does not need), while a rewrite landing in the same millisecond as the
  // read is caught, which an mtime comparison cannot do — timestamps are
  // millisecond-granular in the values they are compared as, and two writes
  // inside one are indistinguishable. A ranged read never reaches here.
  if (content !== read.content) return fail("stale");

  return OK;
}

/**
 * The same question for Write, which replaces a file wholesale.
 *
 * There is no content fallback here, unlike Edit: the content Write is about
 * to install has nothing to do with what was read, so "the bytes still match
 * what you saw" is not a reason to proceed. Either the file is untouched since
 * the model looked at it, or the model looks again.
 */
export function writeGuard(input: {
  /** What the registry holds for this path. */
  read: ReadStateEntry | undefined;
  /** The file's mtime, exactly as `statForGuard` reports it — `null` when it
   *  does not exist. There is no content here on purpose: nothing to compare
   *  it against, so the timestamp is the only evidence Write has. */
  modifiedMs: number | null;
}): GuardVerdict {
  const { read, modifiedMs } = input;

  // No file, nothing to have read — the same reason Edit may not create one.
  if (modifiedMs === null) return OK;
  if (!read) return fail("unread");
  if (read.isPartialView) return fail("partial");
  if (modifiedMs > read.timestamp) return fail("stale");

  return OK;
}

/**
 * Record a file as something the caller has seen, taking the mtime from disk
 * rather than from the caller — so the timestamp and the content cannot
 * disagree about which version of the file they describe.
 *
 * Write and Edit call this after they change a file (the model knows what it
 * just wrote); tests call it to stand in for the Read a real session would
 * have done first. A store that is absent is not an error: the guard is a
 * check, and a caller without one gets no record rather than a crash.
 */
export async function recordKnownState(
  store: ReadStateStore | undefined,
  path: string,
  content: string,
): Promise<void> {
  if (!store) return;
  const timestamp = await statForGuard(path);
  if (timestamp === null) return;
  store.record(path, { timestamp, content });
}

/** `stat` for the guard: `null` for a missing file, and the mtime exactly as
 *  reported otherwise — the same value entries are recorded with, so the two
 *  are comparable. Anything else — EACCES, ELOOP — is not "missing", so it
 *  propagates and the tool reports the real error. */
export async function statForGuard(path: string): Promise<number | null> {
  try {
    const stats = await stat(path);
    return stats.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
