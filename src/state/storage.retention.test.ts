/**
 * Retention deletes files that cannot be recovered, so the threshold it acts
 * on has to be impossible to get wrong.
 *
 * The defect: `cleanupPeriodDays: 0` put the cutoff at "now", so the startup
 * prune deleted *every* saved session — and the settings editor persisted 0
 * whenever the field was emptied. Both ends are covered here: the value is
 * dropped when settings are read, and the pruner refuses an impossible window
 * even if one reaches it.
 *
 * Each case gets its own `DEEPSEEK_CODE_DATA_DIR` — settings are cached per
 * file path, and a fresh path per case keeps one case's read from answering
 * the next one's.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listSessions, loadSettings, pruneOldSessions, saveSettings } from "./storage.js";

const created: string[] = [];
const originalDataDir = process.env.DEEPSEEK_CODE_DATA_DIR;

/** A scratch data dir, installed as the app's store for the duration. */
function useSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "storage-retention-"));
  created.push(dir);
  process.env.DEEPSEEK_CODE_DATA_DIR = dir;
  return dir;
}

function sessionFile(dir: string, name: string, ageDays: number): string {
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const path = join(sessionsDir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ hash: name, messages: [] }));
  const when = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(path, when, when);
  return path;
}

/**
 * Settings as an up-to-date install has them. The schema version matters: a
 * file without one gets the 0→2 migration chain, which already normalizes this
 * key. The case that bites is the *current* schema, where nothing rewrites the
 * value and the editor can still write a 0.
 */
function writeSettings(dir: string, cleanupPeriodDays: unknown): void {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ schemaVersion: 2, cleanupPeriodDays }),
    "utf-8",
  );
}

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DEEPSEEK_CODE_DATA_DIR;
  else process.env.DEEPSEEK_CODE_DATA_DIR = originalDataDir;
});

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("pruneOldSessions", () => {
  test("a zero-day window deletes nothing", () => {
    const dir = useSandbox();
    const old = sessionFile(dir, "old", 10);
    sessionFile(dir, "fresh", 0);

    expect(pruneOldSessions(0)).toBe(0);

    expect(existsSync(old)).toBe(true);
    expect(listSessions().map((s) => s.hash).sort()).toEqual(["fresh", "old"]);
  });

  test("a negative or malformed window deletes nothing", () => {
    const dir = useSandbox();
    sessionFile(dir, "old", 10);

    expect(pruneOldSessions(-1)).toBe(0);
    expect(pruneOldSessions(Number.NaN)).toBe(0);

    expect(listSessions()).toHaveLength(1);
  });

  test("a real window still expires what is past it", () => {
    const dir = useSandbox();
    sessionFile(dir, "old", 40);
    sessionFile(dir, "fresh", 1);

    expect(pruneOldSessions(30)).toBe(1);
    expect(listSessions().map((s) => s.hash)).toEqual(["fresh"]);
  });
});

describe("loadSettings", () => {
  test("drops a cleanup period the rest of the app calls invalid", () => {
    for (const bad of [0, -1, 1.5, 999, "30", null, Number.NaN]) {
      const dir = useSandbox();
      writeSettings(dir, bad);
      expect(loadSettings().cleanupPeriodDays).toBeUndefined();
    }
  });

  test("keeps a valid one", () => {
    const dir = useSandbox();
    writeSettings(dir, 7);

    expect(loadSettings().cleanupPeriodDays).toBe(7);
  });

  test("the next save writes the file back without it", () => {
    const dir = useSandbox();
    writeSettings(dir, 0);

    saveSettings({ verbose: true });

    const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")) as {
      cleanupPeriodDays?: unknown;
      verbose?: unknown;
    };
    expect(onDisk.cleanupPeriodDays).toBeUndefined();
    expect(onDisk.verbose).toBe(true);
  });
});
