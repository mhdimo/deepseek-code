/**
 * The other half of the read-state guard: what happens when a file the model
 * read is changed by someone else while the session is running.
 *
 * The guard refuses the *edit*; this tells the model *why* it is about to be
 * refused, before it spends a turn on a fix built on text that is no longer
 * there. The two have to agree — a notice that moved the entry's content
 * forward would make the guard pass an edit the model never read.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createReadState, editGuard, recordKnownState, statForGuard } from "./readState.js";
import {
  DIFF_ABANDONED,
  MAX_CHANGED_FILES,
  MAX_SNIPPET_CHARS,
  boundedDiff,
  collectFileChanges,
  formatFileChanges,
} from "./fileChangeNotice.js";

/** A temp dir per test, torn down even when the test throws. */
function withDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), "notice-"));
  const done = (result: T | Promise<T>) => {
    if (result instanceof Promise) return result.finally(() => rmSync(dir, { recursive: true, force: true }));
    rmSync(dir, { recursive: true, force: true });
    return result;
  };
  return done(fn(dir));
}

/** Write with an explicit mtime, so "changed since" is a fact of the test
 *  rather than a race with the filesystem's clock granularity. */
function writeAt(path: string, content: string, seconds: number): void {
  writeFileSync(path, content);
  utimesSync(path, seconds, seconds);
}

/** The read a session does: the bytes, recorded against the file's mtime. */
async function readFileAs(store: ReturnType<typeof createReadState>, path: string) {
  await recordKnownState(store, path, readFileSync(path, "utf-8"));
}

describe("collectFileChanges", () => {
  test("a file rewritten after the read is reported, with the diff", async () =>
    withDir(async (dir) => {
      const file = join(dir, "a.ts");
      const store = createReadState();
      writeAt(file, "const x = 1;\n", 1_000_000);
      await readFileAs(store, file);

      writeAt(file, "const x = 2;\n", 1_000_001);
      const changes = await collectFileChanges(store);

      expect(changes.length).toBe(1);
      expect(changes[0]!.path).toBe(file);
      expect(changes[0]!.snippet).toContain("-const x = 1;");
      expect(changes[0]!.snippet).toContain("+const x = 2;");
    }));

  test("it is reported once, not on every turn after", async () =>
    withDir(async (dir) => {
      const file = join(dir, "a.ts");
      const store = createReadState();
      writeAt(file, "one\n", 1_000_000);
      await readFileAs(store, file);
      writeAt(file, "two\n", 1_000_001);

      expect((await collectFileChanges(store)).length).toBe(1);
      // Reported means told. Repeating it every turn is a turn the model
      // spends being reminded of something it already read.
      expect((await collectFileChanges(store)).length).toBe(0);
    }));

  test("a file nobody touched is not news", async () =>
    withDir(async (dir) => {
      const file = join(dir, "a.ts");
      const store = createReadState();
      writeAt(file, "steady\n", 1_000_000);
      await readFileAs(store, file);

      expect(await collectFileChanges(store)).toEqual([]);
    }));

  test("a touched-but-unchanged file is silent, and not reported later either", async () =>
    withDir(async (dir) => {
      const file = join(dir, "a.ts");
      const store = createReadState();
      writeAt(file, "same\n", 1_000_000);
      await readFileAs(store, file);

      // `touch`, a formatter that found nothing to do, a sync client — the
      // clock moves and the bytes do not.
      utimesSync(file, 1_000_100, 1_000_100);
      expect(await collectFileChanges(store)).toEqual([]);
      // Silent, but not deaf: the entry moves with the clock anyway, or a file
      // something touches on every save is read and diffed on every turn for
      // the rest of the session.
      expect(store.get(file)!.timestamp).toBe((await statForGuard(file))!);

      // And a real change after the touch is still caught.
      writeAt(file, "different\n", 1_000_101);
      const changes = await collectFileChanges(store);
      expect(changes.length).toBe(1);
      expect(changes[0]!.snippet).toContain("-same");
      expect(changes[0]!.snippet).toContain("+different");
    }));

  test("a file that has been deleted is forgotten, not reported", async () =>
    withDir(async (dir) => {
      const file = join(dir, "gone.ts");
      const store = createReadState();
      writeAt(file, "here\n", 1_000_000);
      await readFileAs(store, file);
      unlinkSync(file);

      // Edit's own "File does not exist" says it better, and an entry that can
      // never match again is a stat on every remaining turn of the session.
      expect(await collectFileChanges(store)).toEqual([]);
      expect(store.size).toBe(0);
    }));

  test("a file the model only saw part of is named without a diff", async () =>
    withDir(async (dir) => {
      const file = join(dir, "big.ts");
      const store = createReadState();
      writeAt(file, "line one\nline two\n", 1_000_000);
      // What a ranged read records: a window, not the file.
      store.record(file, {
        timestamp: (await statForGuard(file))!,
        content: "line one",
        isPartialView: true,
      });

      writeAt(file, "line one\nline two changed\n", 1_000_001);
      const changes = await collectFileChanges(store);
      expect(changes.length).toBe(1);
      // A diff against something the model never had would be a lie in diff's
      // clothing — and worse than the silence it replaced.
      expect(changes[0]!.snippet).toBe("");
      expect(formatFileChanges(changes)).toContain("only read part of this file");
    }));

  test("a whole tree rewritten at once is capped, and the rest waits a turn", async () =>
    withDir(async (dir) => {
      const store = createReadState();
      const files = Array.from({ length: MAX_CHANGED_FILES + 2 }, (_, i) =>
        join(dir, `f${i}.ts`),
      );
      for (const file of files) {
        writeAt(file, "before\n", 1_000_000);
        await readFileAs(store, file);
      }
      for (const file of files) writeAt(file, "after\n", 1_000_001);

      const first = await collectFileChanges(store);
      expect(first.length).toBe(MAX_CHANGED_FILES);

      // Not dropped: a format-on-save of the whole repo is one notice per turn
      // until it is done, rather than one turn with the entire tree in it.
      const second = await collectFileChanges(store);
      expect(second.map((c) => c.path).sort()).toEqual(
        files.filter((f) => !first.some((c) => c.path === f)).sort(),
      );
    }));

  test("what it reports is still stale to the guard", async () =>
    withDir(async (dir) => {
      const file = join(dir, "a.ts");
      const store = createReadState();
      writeAt(file, "the text the model read\n", 1_000_000);
      await readFileAs(store, file);
      writeAt(file, "somebody else's text\n", 1_000_001);

      const changes = await collectFileChanges(store);
      expect(changes.length).toBe(1);

      // The notice is a warning, not a read: the entry keeps the old content,
      // so an edit still lands on "read it again" instead of matching
      // `old_string` against a file the model has never seen.
      const verdict = editGuard({
        oldString: "the text the model read",
        newString: "x",
        read: store.get(file),
        modifiedMs: await statForGuard(file),
        content: readFileSync(file, "utf-8"),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toBe("stale");
    }));
});

describe("boundedDiff", () => {
  test("a small diff is handed over whole", () => {
    const text = boundedDiff("a.ts", "one\ntwo\n", "one\nTWO\n");
    expect(text).toContain("-two");
    expect(text).toContain("+TWO");
    expect(text).not.toContain("truncated");
  });

  test("a rewrite of a huge file is cut off rather than injected in full", () => {
    // Every line different: the diff is the whole file twice over, which is
    // what a formatter run against an unformatted file produces.
    //
    // 300 lines, not 4,000. The cap is on characters, so 300 all-different
    // lines already overflow it by half again, and the diff library's work
    // grows with the *product* of the two lengths — at 4,000 this test ran
    // right up against the 5s budget in DIFF_TIMEOUT_MS and passed or failed
    // depending on what else the machine was doing. The abandonment case that
    // that flakiness was really probing is covered by the test below, which
    // triggers it on purpose instead of hoping to.
    const before = Array.from({ length: 300 }, (_, i) => `line ${i} as written`).join("\n");
    const after = Array.from({ length: 300 }, (_, i) => `line ${i} as formatted`).join("\n");
    const text = boundedDiff("a.ts", before, after);
    expect(text.length).toBeLessThan(MAX_SNIPPET_CHARS + 200);
    expect(text.endsWith("read the file for the rest)")).toBe(true);
  });

  test("a diff that runs out of budget says so, rather than going silent", () => {
    // The library abandons the work when it overruns its budget and returns
    // undefined, which reaches boundedDiff as an empty patch. Empty is also
    // what formatFileChanges reads as "you only read part of this file", so
    // an abandoned diff used to tell the model something untrue about its own
    // context. A budget already in the past takes the same branch a real
    // overrun takes — the library compares the clock against the deadline
    // before each pass of its loop — without waiting for one. Zero would not
    // do: the deadline would be "now", and a small input can finish before the
    // clock ticks.
    const before = "one\ntwo\n";
    const after = "one\nTWO\n";
    expect(boundedDiff("a.ts", before, after)).toContain("-two");

    const text = boundedDiff("a.ts", before, after, -1);
    expect(text).toBe(DIFF_ABANDONED);
    expect(text).not.toBe("");
  });
});

describe("formatFileChanges", () => {
  test("nothing to say is the empty string, so callers can check", () => {
    // The same contract task notifications have: no news is not a turn.
    expect(formatFileChanges([])).toBe("");
  });

  test("it says whose message this is not", () => {
    // The text arrives as a user turn, because that is the only way in — the
    // engine owns history. Without this the model reads it as the user
    // talking, and answers it.
    const text = formatFileChanges([{ path: "/a.ts", snippet: "@@ -1,1 +1,1 @@" }]);
    expect(text).toContain("A file you read has changed");
    expect(text).toContain("not a message from the user");
    expect(text).toContain('<file-changed path="/a.ts">');
    expect(text).toContain("read a file again before editing it");
  });

  test("several files are counted, not listed one by one", () => {
    const text = formatFileChanges([
      { path: "/a.ts", snippet: "x" },
      { path: "/b.ts", snippet: "y" },
    ]);
    expect(text).toContain("2 files you read have changed");
  });

  test("a path that would break the block is escaped", () => {
    // Paths are legal filenames with quotes and angle brackets in them, and
    // the block is XML the model parses by eye.
    const text = formatFileChanges([
      { path: '/tmp/a" onmouseover="x.ml', snippet: "s" },
    ]);
    expect(text).toContain(`path="/tmp/a&quot; onmouseover=&quot;x.ml"`);
    expect(text).not.toContain('onmouseover="x.ml"');
  });
});
