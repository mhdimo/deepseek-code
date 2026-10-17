/**
 * `respondToBashCommands` has to survive a restart in both directions.
 *
 * Claude Code's setting defaults to on: after a `!command`, the model answers
 * the output. `false` restores the older "output waits for the next prompt"
 * behavior — which only works if `loadPersistedSettings` copies the stored
 * `false` through. The bypass test above documents the opposite convention
 * for its own flag; this one would be silently on forever if it copied that
 * "only ever set true" rule.
 *
 * Home and the data dir are redirected before the import, as in
 * persistedBypass.test.ts — `USER_CONFIG_PATHS` is built at module load.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-respond-bash-"));
const home = join(sandbox, "home");
const dataDir = join(sandbox, "data");
mkdirSync(home, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const savedHome = process.env.HOME;
const savedDataDir = process.env.DEEPSEEK_CODE_DATA_DIR;
process.env.HOME = home;
process.env.DEEPSEEK_CODE_DATA_DIR = dataDir;

const { loadConfig } = await import("../../src/utils/config.js");

/** `loadSettings` caches against the file's mtime; see persistedBypass. */
let clock = 1_700_000_000;
function writeSettings(settings: Record<string, unknown>): void {
  const path = join(dataDir, "settings.json");
  writeFileSync(path, JSON.stringify(settings, null, 2));
  clock += 10;
  utimesSync(path, clock, clock);
}

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedDataDir === undefined) delete process.env.DEEPSEEK_CODE_DATA_DIR;
  else process.env.DEEPSEEK_CODE_DATA_DIR = savedDataDir;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("a persisted bash-response setting", () => {
  test("false is read back — the opt-out is not swallowed", () => {
    writeSettings({ schemaVersion: 3, respondToBashCommands: false });
    expect(loadConfig().respondToBashCommands).toBe(false);
  });

  test("true is read back as true", () => {
    writeSettings({ schemaVersion: 3, respondToBashCommands: true });
    expect(loadConfig().respondToBashCommands).toBe(true);
  });

  test("an absent key leaves it undefined — which the app reads as on", () => {
    writeSettings({ schemaVersion: 3 });
    expect(loadConfig().respondToBashCommands).toBeUndefined();
  });
});
