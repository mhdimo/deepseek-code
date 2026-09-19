/**
 * Spilled output is a cache, and something has to reclaim it.
 *
 * Every command that produces more than the inline cap leaves a file behind;
 * nothing else deletes them, so an install that runs verbose commands for a
 * year accumulates them without bound. Startup prunes them on the same
 * `cleanupPeriodDays` clock as sessions.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pruneOldToolOutputs, spillNote, spillPath, toolOutputsDir } from "./toolOutputs.js";

const sandbox = mkdtempSync(join(tmpdir(), "tooloutputs-"));
process.env.DEEPSEEK_CODE_DATA_DIR = sandbox;

function spillFile(name: string, ageDays: number): string {
  const path = join(toolOutputsDir(), name);
  mkdirSync(toolOutputsDir(), { recursive: true });
  writeFileSync(path, "x");
  if (ageDays > 0) {
    const when = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path, when, when);
  }
  return path;
}

beforeEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("pruneOldToolOutputs", () => {
  test("removes spills past the cutoff and keeps recent ones", () => {
    const old = spillFile("old-stdout.txt", 40);
    const fresh = spillFile("fresh-stdout.txt", 1);

    expect(pruneOldToolOutputs(30)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("is quietly a no-op before anything spilled", () => {
    expect(pruneOldToolOutputs(30)).toBe(0);
  });

  test("a zero-day window expires nothing", () => {
    const spilled = spillFile("aged-stdout.txt", 40);

    expect(pruneOldToolOutputs(0)).toBe(0);
    expect(existsSync(spilled)).toBe(true);
  });
});

describe("spill paths", () => {
  test("live under the data dir, separated per stream", () => {
    expect(spillPath("abc123", "stdout")).toBe(join(toolOutputsDir(), "abc123-stdout.txt"));
    expect(spillPath("abc123", "stderr")).not.toBe(spillPath("abc123", "stdout"));
  });

  test("the note names a path when nothing was dropped", () => {
    const spill = { path: "/tmp/x.txt", bytes: 10, capped: false } as never;
    expect(spillNote(spill)).toBe("full output in /tmp/x.txt");
  });
});
