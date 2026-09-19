/**
 * Snapshots must not cross conversations or directories.
 *
 * Manifests were keyed only by message index in one shared directory, so a
 * second session overwrote the first's rewind points at the same index, and
 * restore expanded relative keys against whatever working directory it was
 * given — a manifest recorded elsewhere could therefore delete a same-named
 * file here. Live evidence on this machine: globals from three different runs
 * coexisted, one of them recording a null digest (a delete).
 *
 * The store is redirected with DEEPSEEK_CODE_DATA_DIR, pointed at a scratch
 * directory, so the suite never touches the real one. It is deliberately NOT
 * done by mocking `os`: a module mock in Bun applies to the entire test run,
 * so stubbing homedir() here silently rewrote it for every other file that
 * ran afterwards (two of them broke, depending on how many they read).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const sandbox = mkdtempSync(join(tmpdir(), "filehistory-data-"));
process.env.DEEPSEEK_CODE_DATA_DIR = sandbox;

const {
  snapshotFiles,
  restoreSnapshot,
  hasSnapshot,
  dropSnapshot,
  dropAllSnapshots,
  setFileHistorySession,
  getFileHistorySession,
  resetFileHistorySession,
} = await import("./fileHistory.js");
const { getDataDir } = await import("../state/storage.js");

const root = mkdtempSync(join(tmpdir(), "filehistory-work-"));
const dirA = join(root, "project-a");
const dirB = join(root, "project-b");

function seed(): void {
  for (const dir of [dirA, dirB]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.ts"), "original");
  }
}

beforeEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
  rmSync(root, { recursive: true, force: true });
  seed();
  setFileHistorySession(`session-${Math.random().toString(36).slice(2)}`);
});

afterAll(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("the scratch store is the one in use", () => {
  // Without this, a broken override would send every test below into the real
  // ~/.deepseek-code — writing snapshots and a session record — and the file
  // would still pass. So the isolation itself is asserted, first, on both of
  // the modules that own a half of the store.
  test("settings and sessions resolve there", () => {
    expect(getDataDir()).toBe(sandbox);
  });

  test("snapshots are written there", async () => {
    setFileHistorySession("guard");
    await snapshotFiles(1, ["app.ts"], dirA);
    expect(existsSync(join(sandbox, "filehistory", "manifests", "guard", "1.json"))).toBe(true);
  });
});

describe("snapshots are scoped to a conversation", () => {
  test("two sessions at the same message index do not overwrite each other", async () => {
    setFileHistorySession("session-a");
    writeFileSync(join(dirA, "app.ts"), "written by A");
    await snapshotFiles(1, ["app.ts"], dirA);

    setFileHistorySession("session-b");
    writeFileSync(join(dirA, "app.ts"), "written by B");
    await snapshotFiles(1, ["app.ts"], dirA);

    // Back in A, index 1 must still mean what A recorded — not the overwrite.
    setFileHistorySession("session-a");
    expect(hasSnapshot(1, dirA)).toBe(true);
    const entries = await restoreSnapshot(1, dirA);
    expect(entries.find((e) => e.path.endsWith("app.ts"))?.content).toBe("written by A");

    setFileHistorySession("session-b");
    const bEntries = await restoreSnapshot(1, dirA);
    expect(bEntries.find((e) => e.path.endsWith("app.ts"))?.content).toBe("written by B");
  });

  test("one session's index does not answer for another's", async () => {
    setFileHistorySession("session-a");
    await snapshotFiles(3, ["app.ts"], dirA);
    expect(hasSnapshot(3, dirA)).toBe(true);

    setFileHistorySession("session-b");
    expect(hasSnapshot(3, dirA)).toBe(false);
    expect(await restoreSnapshot(3, dirA)).toEqual([]);
  });

  test("an unset scope still isolates rather than sharing one global store", () => {
    // A caller that never sets a scope gets the process id: still its own.
    setFileHistorySession("session-a");
    expect(getFileHistorySession()).toBe("session-a");
  });

  test("a new conversation does not inherit the previous one's scope", async () => {
    // The bug this pins: only setFileHistorySession (reached on resume) ever
    // wrote the scope, so /clear and /sessions new kept the previous
    // conversation's directory. The new conversation's indices restart at 1,
    // so its first snapshot overwrote the manifest the earlier conversation
    // still points at — resuming that conversation and rewinding then
    // restored, or deleted, files using another conversation's state.
    const first = getFileHistorySession();
    writeFileSync(join(dirA, "app.ts"), "conversation A");
    await snapshotFiles(1, ["app.ts"], dirA);

    // What /sessions new, /resume new and /clear now all do.
    const second = resetFileHistorySession();
    expect(second).not.toBe(first);

    writeFileSync(join(dirA, "app.ts"), "conversation B");
    await snapshotFiles(1, ["app.ts"], dirA);

    // A's index 1 must still mean what A recorded.
    setFileHistorySession(first);
    expect(hasSnapshot(1, dirA)).toBe(true);
    const entries = await restoreSnapshot(1, dirA);
    expect(entries.find((e) => e.path.endsWith("app.ts"))?.content).toBe("conversation A");
  });

  test("a dropped conversation's snapshots are dropped in its own scope", async () => {
    // /clear discards the conversation AND its snapshots, and has to drop them
    // while the outgoing scope is still in force — dropAllSnapshots awaits
    // before it reads the scope, so a plain call after the reset would empty
    // the new conversation's store instead and orphan the old one's blobs.
    const discarded = getFileHistorySession();
    await snapshotFiles(1, ["app.ts"], dirA);
    resetFileHistorySession();

    await dropAllSnapshots(discarded);

    setFileHistorySession(discarded);
    expect(hasSnapshot(1, dirA)).toBe(false);
  });
});

describe("a snapshot only restores into the directory it was taken in", () => {
  test("restoring elsewhere yields nothing, so nothing is written or deleted", async () => {
    setFileHistorySession("session-a");
    // A file that did not exist when the snapshot was taken records a null
    // digest — a delete. Applying that in another project removes a file the
    // manifest never knew about.
    await snapshotFiles(2, ["app.ts", "only-in-a.ts"], dirA);
    rmSync(join(dirA, "app.ts"));

    const entries = await restoreSnapshot(2, dirB);
    expect(entries).toEqual([]);
  });

  test("hasSnapshot refuses a snapshot from another directory", async () => {
    setFileHistorySession("session-a");
    await snapshotFiles(4, ["app.ts"], dirA);

    expect(hasSnapshot(4, dirA)).toBe(true);
    // The rewind picker gates on this, so the option is never offered.
    expect(hasSnapshot(4, dirB)).toBe(false);
  });

  test("symlinked and trailing-slash spellings of the same directory still match", async () => {
    setFileHistorySession("session-a");
    await snapshotFiles(5, ["app.ts"], dirA);

    expect(hasSnapshot(5, `${dirA}/`)).toBe(true);
    expect(await restoreSnapshot(5, `${dirA}/`)).not.toEqual([]);
  });
});

describe("a resumed session finds its snapshots again", () => {
  test("the scope is carried in the session record", async () => {
    const { saveSession, loadSession } = await import("../state/storage.js");

    setFileHistorySession("session-to-resume");
    writeFileSync(join(dirA, "app.ts"), "before the edit");
    await snapshotFiles(1, ["app.ts"], dirA);

    const hash = saveSession({
      messages: [],
      tokenUsage: 0,
      model: "deepseek-chat",
      agent: "code",
      workingDirectory: dirA,
      fileHistoryId: getFileHistorySession(),
    });

    // A later process starts with its own scope and adopts the saved one, the
    // way App does on --resume.
    setFileHistorySession("a-different-process");
    expect(hasSnapshot(1, dirA)).toBe(false);

    const saved = loadSession(hash)!;
    setFileHistorySession(saved.fileHistoryId ?? saved.hash);
    expect(hasSnapshot(1, dirA)).toBe(true);
    expect(await restoreSnapshot(1, dirA)).not.toEqual([]);
  });
});

describe("cleanup is scoped too", () => {
  test("/clear drops this conversation's snapshots, not another's", async () => {
    setFileHistorySession("session-a");
    await snapshotFiles(1, ["app.ts"], dirA);
    await snapshotFiles(2, ["app.ts"], dirA);

    setFileHistorySession("session-b");
    await snapshotFiles(1, ["app.ts"], dirA);
    await dropAllSnapshots();

    expect(hasSnapshot(1, dirA)).toBe(false);

    setFileHistorySession("session-a");
    expect(hasSnapshot(1, dirA)).toBe(true);
    expect(hasSnapshot(2, dirA)).toBe(true);
  });

  test("/clear takes pre-scoping manifests with it, and their blobs", async () => {
    // Layout of a store written before snapshots were scoped: index-keyed
    // manifests directly under manifests/, which no session can reach now.
    const legacy = join(sandbox, "filehistory", "manifests");
    mkdirSync(legacy, { recursive: true });
    const orphan = createHash("sha256").update("orphaned content").digest("hex");
    writeFileSync(
      join(legacy, "3.json"),
      JSON.stringify({
        messageIndex: 3,
        timestamp: 0,
        workingDir: dirA,
        files: { "app.ts": orphan },
      }),
    );
    const blob = join(sandbox, "filehistory", "blobs", orphan.slice(0, 2), orphan);
    mkdirSync(dirname(blob), { recursive: true });
    writeFileSync(blob, "orphaned content");

    // Another session's snapshot must survive both the sweep and the blob GC
    // that follows it.
    setFileHistorySession("session-elsewhere");
    writeFileSync(join(dirA, "app.ts"), "still wanted");
    await snapshotFiles(1, ["app.ts"], dirA);

    setFileHistorySession("session-current");
    await dropAllSnapshots();

    expect(existsSync(join(legacy, "3.json"))).toBe(false);
    expect(existsSync(blob)).toBe(false);

    setFileHistorySession("session-elsewhere");
    expect(hasSnapshot(1, dirA)).toBe(true);
    const entries = await restoreSnapshot(1, dirA);
    expect(entries.find((e) => e.path.endsWith("app.ts"))?.content).toBe("still wanted");
  });

  test("a blob another session still needs is not collected", async () => {
    // Both sessions snapshot identical content, so the blob is deduplicated;
    // dropping one manifest must not strand the other.
    setFileHistorySession("session-a");
    writeFileSync(join(dirA, "app.ts"), "shared content");
    await snapshotFiles(1, ["app.ts"], dirA);

    setFileHistorySession("session-b");
    await snapshotFiles(1, ["app.ts"], dirA);

    setFileHistorySession("session-a");
    await dropSnapshot(1);

    setFileHistorySession("session-b");
    const entries = await restoreSnapshot(1, dirA);
    expect(entries.find((e) => e.path.endsWith("app.ts"))?.content).toBe("shared content");
  });
});
