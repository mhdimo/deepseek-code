/**
 * The read-state guard, which is the difference between an edit the model
 * grounded in what it read and one it made up.
 *
 * The decisions are pure and are tested as decisions; what the tools do with
 * the disk is tested in each tool's own file.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createReadState,
  editGuard,
  writeGuard,
  statForGuard,
  MAX_READ_STATE_ENTRIES,
  EDIT_MESSAGES,
  type ReadStateEntry,
} from "./readState.js";

const entry = (over: Partial<ReadStateEntry> = {}): ReadStateEntry => ({
  timestamp: 1_000,
  content: "hello world",
  ...over,
});

const edits = (over: Partial<Parameters<typeof editGuard>[0]> = {}) => ({
  oldString: "hello",
  newString: "goodbye",
  read: entry() as ReadStateEntry | undefined,
  modifiedMs: 1_000 as number | null,
  content: "hello world" as string | null,
  ...over,
});

describe("editGuard", () => {
  test("an edit the model read and nobody touched goes through", () => {
    expect(editGuard(edits()).ok).toBe(true);
  });

  test("an edit of a file nobody read is refused", () => {
    const verdict = editGuard(edits({ read: undefined }));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("unread");
  });

  test("an edit of a file that changed under the model is refused", () => {
    const verdict = editGuard(
      edits({ modifiedMs: 2_000, content: "rewritten by someone else" }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("stale");
  });

  test("a rewrite that lands in the same millisecond is still stale", () => {
    // The case an mtime comparison cannot see: the file changed and the
    // timestamps compare equal. Comparing the bytes the model was shown is
    // what catches it, and it is why this check does not consult the clock.
    const verdict = editGuard(edits({ modifiedMs: 1_000, content: "different bytes" }));
    expect(verdict.ok === false && verdict.reason).toBe("stale");
  });

  test("a touched-but-unchanged file is not stale", () => {
    // The mtime moved but the bytes did not: `touch`, a formatter that found
    // nothing to do, a sync client. Sending the model back for a re-read it
    // does not need is its own cost.
    expect(editGuard(edits({ modifiedMs: 5_000 })).ok).toBe(true);
  });

  test("a ranged read is not a read", () => {
    // The model has seen lines 40-60 of a 900-line file; `old_string` may
    // match, but the edit is being made against context it never had.
    const verdict = editGuard(edits({ read: entry({ isPartialView: true }) }));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("partial");
  });

  test("a missing file is its own answer, not a stale one", () => {
    const verdict = editGuard(
      edits({ read: undefined, modifiedMs: null, content: null }),
    );
    expect(verdict.ok === false && verdict.reason).toBe("missing");
    // "Read it first" would send the model to read a file that is not there.
    expect(verdict.ok === false && verdict.message).toBe(EDIT_MESSAGES.missing);
  });

  test("no changes is refused rather than reported as a successful edit", () => {
    // This used to write the file back byte-for-byte and answer "Edited",
    // which read to the model as work done.
    const verdict = editGuard(edits({ newString: "hello" }));
    expect(verdict.ok === false && verdict.reason).toBe("unchanged");
  });

  test("an empty old_string is refused before the read state is consulted", () => {
    // The ordering matters: "File has not been read yet" would send the model
    // back to read a file when the actual mistake is the empty string.
    const verdict = editGuard(edits({ oldString: "", read: undefined }));
    expect(verdict.ok === false && verdict.reason).toBe("empty");
  });
});

describe("writeGuard", () => {
  const write = (over: Partial<Parameters<typeof writeGuard>[0]> = {}) => ({
    read: entry() as ReadStateEntry | undefined,
    modifiedMs: 1_000 as number | null,
    ...over,
  });

  test("a new file needs no read", () => {
    // There is nothing to have read, and refusing here would make Write
    // useless for the case it is most used for.
    expect(writeGuard(write({ read: undefined, modifiedMs: null })).ok).toBe(true);
  });

  test("overwriting a file nobody read is refused", () => {
    expect(writeGuard(write({ read: undefined })).ok).toBe(false);
  });

  test("a file that changed since the read is refused, bytes or no bytes", () => {
    // Edit may fall back on comparing content; Write may not — what it is
    // about to install has nothing to do with what was read, so "the bytes
    // still match" is not a reason to overwrite them.
    const verdict = writeGuard(write({ modifiedMs: 2_000 }));
    expect(verdict.ok === false && verdict.reason).toBe("stale");
  });

  test("a ranged read is not a read", () => {
    expect(writeGuard(write({ read: entry({ isPartialView: true }) })).ok).toBe(false);
  });
});

describe("the registry", () => {
  test("records what was read and reports it back", () => {
    const store = createReadState();
    store.record("/a.ts", entry());
    expect(store.get("/a.ts")?.content).toBe("hello world");
    expect(store.get("/b.ts")).toBeUndefined();
  });

  test("re-reading a file replaces the entry rather than adding one", () => {
    const store = createReadState();
    store.record("/a.ts", entry());
    store.record("/a.ts", entry({ timestamp: 2_000, content: "changed" }));
    expect(store.size).toBe(1);
    expect(store.get("/a.ts")?.timestamp).toBe(2_000);
  });

  test("it stays bounded, dropping the least recently touched file", () => {
    // The entry holds the file's text, so an unbounded registry is a slow leak
    // of every file the session has read.
    const store = createReadState(2);
    store.record("/a.ts", entry());
    store.record("/b.ts", entry());
    store.record("/c.ts", entry());
    expect(store.size).toBe(2);
    expect(store.get("/a.ts")).toBeUndefined();
    expect(store.get("/c.ts")).toBeDefined();
  });

  test("re-recording a file keeps it out of the eviction order's front", () => {
    const store = createReadState(2);
    store.record("/a.ts", entry());
    store.record("/b.ts", entry());
    store.record("/a.ts", entry({ timestamp: 2_000 }));
    store.record("/c.ts", entry());
    expect(store.get("/a.ts")).toBeDefined();
    expect(store.get("/b.ts")).toBeUndefined();
  });

  test("the default bound is the documented one", () => {
    const store = createReadState();
    for (let i = 0; i < MAX_READ_STATE_ENTRIES + 10; i++) {
      store.record(`/f${i}.ts`, entry());
    }
    expect(store.size).toBe(MAX_READ_STATE_ENTRIES);
  });
});

describe("statForGuard", () => {
  test("it reports the mtime exactly, unrounded", async () => {
    // Rounding to whole milliseconds is what makes two writes inside one
    // millisecond compare as equal, and Write has only the timestamp to go on
    // — Edit compares content and does not care. (On a filesystem whose
    // mtimes are already whole milliseconds this test cannot tell the
    // difference; everywhere else it can.)
    const dir = mkdtempSync(join(tmpdir(), "readstate-"));
    const path = join(dir, "f.txt");
    writeFileSync(path, "x");
    try {
      expect(await statForGuard(path)).toBe(statSync(path).mtimeMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file that is not there is null, not an exception", async () => {
    expect(await statForGuard(join(tmpdir(), "definitely-not-here-9f3a.txt"))).toBeNull();
  });
});
