/**
 * The "Skip Permissions" decision has to survive a restart.
 *
 * The settings panel writes `dangerouslySkipPermissions` and nothing read it
 * back — `loadPersistedSettings` copied apiKey/model/baseURL/defaultAgent/
 * themeMode/effort and stopped there. So the opt-out was persisted faithfully
 * and then ignored on the next run, with nothing on screen to say so: the
 * user asked not to be prompted and was prompted again.
 *
 * Home and the data dir are both redirected, and before the import rather than
 * after: `USER_CONFIG_PATHS` is built at module load from `homedir()`, so a
 * real `~/.deepseek-code.json` would otherwise outrank the file under test.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-persisted-bypass-"));
const home = join(sandbox, "home");
const dataDir = join(sandbox, "data");
mkdirSync(home, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const savedHome = process.env.HOME;
const savedDataDir = process.env.DEEPSEEK_CODE_DATA_DIR;
process.env.HOME = home;
process.env.DEEPSEEK_CODE_DATA_DIR = dataDir;

const { loadConfig } = await import("../../src/utils/config.js");
const { loadSettings } = await import("../../src/state/storage.js");

/** `loadSettings` caches against the file's mtime, and these writes are
 *  milliseconds apart — two landing in the same one would serve the previous
 *  test's settings back and quietly weaken every assertion below it. */
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

describe("a persisted bypass decision", () => {
  test("is read back into the config", () => {
    writeSettings({ schemaVersion: 3, dangerouslySkipPermissions: true });
    expect(loadConfig().dangerouslySkipPermissions).toBe(true);
  });

  test("a stored false does not turn it on", () => {
    writeSettings({ schemaVersion: 3, dangerouslySkipPermissions: false });
    expect(loadConfig().dangerouslySkipPermissions).toBeFalsy();
  });

  test("an absent key does not turn it on", () => {
    writeSettings({ schemaVersion: 3 });
    expect(loadConfig().dangerouslySkipPermissions).toBeFalsy();
  });

  test("a legacy file is read through the whole chain", () => {
    // The audit finding end to end: the key the old panel wrote, with no
    // schema version and no permissions object, arrives as the flag the
    // permission callback and the startup gate both understand — and brings
    // no allow rule with it.
    writeSettings({ bypassPermissions: true });
    const config = loadConfig();

    expect(config.dangerouslySkipPermissions).toBe(true);
    // Read where it actually lands: `config.permissions` comes from a config
    // *file*, not from settings, so asserting on it here would pass whether or
    // not the migration wrote a rule.
    expect(loadSettings().permissions?.allow ?? []).toEqual([]);
  });
});
