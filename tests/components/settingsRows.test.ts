import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildSettingsRows,
  type Setting,
  type SettingsRowContext,
} from "../../src/components/settingsRows";
import type { PersistedSettings } from "../../src/state/storage";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-settings-rows-"));
const home = join(sandbox, "home");
const dataDir = join(sandbox, "data");
mkdirSync(home, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const savedHome = process.env.HOME;
const savedDataDir = process.env.DEEPSEEK_CODE_DATA_DIR;
process.env.HOME = home;
process.env.DEEPSEEK_CODE_DATA_DIR = dataDir;

let clock = 1_700_000_000;
function writeSettingsFile(settings: Record<string, unknown>): void {
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

function build(
  settings: PersistedSettings = {},
  context: Partial<SettingsRowContext> = {},
): { rows: Setting[]; written: Array<Partial<PersistedSettings>> } {
  const written: Array<Partial<PersistedSettings>> = [];
  const rows = buildSettingsRows({
    settings,
    persist: (partial) => written.push(partial),
    ...context,
  });
  return { rows, written };
}

function row<T extends Setting["type"]>(
  rows: Setting[],
  id: string,
): Extract<Setting, { type: T }> {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found as Extract<Setting, { type: T }>;
}

test("every key the app reads back has a row", () => {
  // The panel's job is to reach the settings the app actually consumes. Each
  // of these has a reader (loadPersistedSettings, App's startup reads, the
  // permission engine) and had no control before.
  const { rows } = build();
  const ids = rows.map((r) => r.id);
  expect(ids).toContain("copyFullResponse");
  expect(ids).toContain("skipPermissions");
  expect(ids).toContain("includeCoAuthoredBy");
});

test("no row writes a key nothing reads back", () => {
  // spinnerTipsEnabled and verbose were persisted here and read nowhere: the
  // spinner has no tip line and the TUI has no verbose output at all.
  const { rows } = build();
  const ids = rows.map((r) => r.id);
  expect(ids).not.toContain("spinnerTipsEnabled");
  expect(ids).not.toContain("verbose");
  // thinkingMode was a display flag (off|whale) that painted a StatusBar chip
  // and reached no further — the engine never read it, which is why /think
  // looked inert. Thinking is reasoning effort now, and effort has its own row.
  expect(ids).not.toContain("thinkingMode");
  // The provider row wrote settings.provider, which loadConfig discards
  // outright (`merged.provider = "deepseek"`), so it changed nothing either.
  expect(ids).not.toContain("provider");
});

test("toggling copy full response persists the key App's /copy reads", () => {
  const { rows, written } = build();
  const setting = row<"boolean">(rows, "copyFullResponse");
  expect(setting.value).toBe(false);
  setting.onChange(true);
  expect(written).toEqual([{ copyFullResponse: true }]);
});

test("skip permissions reaches the live bypass grant", () => {
  const grants: boolean[] = [];
  const { rows, written } = build({}, {
    handlers: { onSkipPermissionsChange: (v) => grants.push(v) },
  });
  const setting = row<"boolean">(rows, "skipPermissions");
  expect(setting.value).toBe(false);
  setting.onChange(true);
  expect(written).toEqual([{ dangerouslySkipPermissions: true }]);
  // Persisting alone would leave the running session's Shift+Tab cycle — which
  // asks the grant directly (services/bypassMode.ts) — on the old value.
  expect(grants).toEqual([true]);
});

test("refuses to grant bypass where the startup gate would refuse it", () => {
  const grants: boolean[] = [];
  const { rows, written } = build({}, {
    bypassPermitted: () => false,
    handlers: { onSkipPermissionsChange: (v) => grants.push(v) },
  });
  const setting = row<"boolean">(rows, "skipPermissions");
  setting.onChange(true);
  // Persisted-and-ignored would be worse than inert: the next launch exits at
  // the gate with nothing on screen to explain the refusal.
  expect(written).toEqual([]);
  expect(grants).toEqual([]);
  expect(setting.description).toContain("Unavailable");

  // Turning it off stays available — that is the way out of a grant written by
  // an earlier run or by hand.
  setting.onChange(false);
  expect(written).toEqual([{ dangerouslySkipPermissions: false }]);
});

test("effort writes a level, and auto clears the key", () => {
  // "off" disables thinking on purpose; "auto" is the key being absent, which
  // is what leaves the choice to the provider. Writing "off" for auto is how
  // the two got confused — /effort auto used to silently disable thinking.
  const { rows, written } = build({ effort: "medium" });
  const setting = row<"enum">(rows, "effort");
  expect(setting.value).toBe("medium");
  setting.onChange("off");
  expect(written).toEqual([{ effort: "off" }]);
  setting.onChange("auto");
  expect(written).toEqual([{ effort: "off" }, { effort: undefined }]);
});

test("theme row hands the value to App rather than repainting behind it", () => {
  const applied: string[] = [];
  const { rows, written } = build(
    { themeMode: "dark" },
    { handlers: { onThemeModeChange: (s) => applied.push(s) } },
  );
  const setting = row<"enum">(rows, "themeMode");
  setting.onChange("light");
  expect(written).toEqual([{ themeMode: "light" }]);
  expect(applied).toEqual(["light"]);
});

test("every editable row writes something when it is changed", () => {
  const { rows, written } = build();

  for (const setting of rows) {
    if (setting.type === "display") continue;
    const before = written.length;
    if (setting.type === "boolean") setting.onChange(!setting.value);
    else if (setting.type === "enum") setting.onChange(setting.options[0]!);
    else setting.onChange(setting.editSeed || "1");
    expect(written.length).toBeGreaterThan(before);
  }
});

test("display rows describe state that lives somewhere else", () => {
  const { rows } = build({
    permissions: { allow: ["Read"], deny: [], ask: ["Bash"] },
    statusLine: { type: "command", command: "git branch --show-current" },
    env: { FOO: "bar", BAZ: "qux" },
  });
  const permissions = row<"display">(rows, "permissions");
  expect(permissions.value).toBe("allow 1 · deny 0 · ask 1");
  expect(row<"display">(rows, "statusLine").value).toContain("git branch");
  expect(row<"display">(rows, "env").value).toBe("2 variable(s) configured");
  expect(row<"display">(rows, "statusLine").type).toBe("display");
});

test("the API key row shows a mask but seeds the editor empty", () => {
  const { rows } = build({ apiKey: "sk-abcdefghijklmnop" });
  const setting = row<"text">(rows, "apiKey");
  expect(setting.value).toBe("sk-abcde…mnop");
  // Seeding the editor with the mask would commit the mask over the key.
  expect(setting.editSeed).toBe("");
});

test("cleanup period rejects a window that would delete everything", () => {
  const { rows, written } = build();
  const setting = row<"text">(rows, "cleanupPeriodDays");
  expect(setting.validate?.("0")).toBe(false);
  expect(setting.validate?.("366")).toBe(false);
  expect(setting.validate?.("30")).toBe(true);
  setting.onChange("0");
  expect(written).toEqual([]);
  setting.onChange("30");
  expect(written).toEqual([{ cleanupPeriodDays: 30 }]);
});
