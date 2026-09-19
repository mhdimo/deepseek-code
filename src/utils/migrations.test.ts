/**
 * What a legacy settings file becomes when the app reads it.
 *
 * The migration that matters here is the one that used to turn a "never ask
 * me" opt-in into the allow rule `Bash(*:**)`. That rule reads as "all bash"
 * to anyone skimming it and is nothing of the sort: `matchShellCommand` finds
 * no `prefix:*` form in it, falls through to the wildcard matcher, and compiles
 * the two stars to `.*` while leaving the colon alone. The compiled regex is
 * the only place the truth lives, so the test that matters is the one that runs
 * the real matcher over the result rather than asserting on the string.
 *
 * The other half is that a stored `false` — and a settings file that never
 * mentioned the flag — must not become a grant. A migration is the last place
 * that should invent authority.
 */
import { describe, expect, test } from "bun:test";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import { matchToolInput, parseRules } from "../services/permissions.js";
import type { PersistedSettings } from "../state/storage.js";

/** Does the settings file, as loaded, auto-approve this Bash command? */
function autoApproves(settings: PersistedSettings, command: string): boolean {
  const rules = parseRules(settings.permissions?.allow ?? [], "allow");
  return rules.some((rule) => matchToolInput(rule, "Bash", { command }, process.cwd()));
}

describe("a legacy bypass flag", () => {
  test("is carried on the key the app reads, not turned into a rule", () => {
    const settings = { bypassPermissions: true } as unknown as PersistedSettings;
    const result = runMigrations(settings);

    expect(result.settings.dangerouslySkipPermissions).toBe(true);
    expect("bypassPermissions" in result.settings).toBe(false);
    // The regression, in the plainest form: no allow rule is synthesised.
    expect(result.settings.permissions?.allow ?? []).toEqual([]);
  });

  test("carries it in that step alone, not only once the chain has run", () => {
    // Pinned against the step rather than through `runMigrations`: 2→3 strips
    // the sentinel back out and restores the flag, so a chain-level test sees
    // the same end state whether or not 0→1 got this right. That was measured —
    // a mutation putting the sentinel back survived every chain-level
    // assertion in this file until this test existed. The point of the step is
    // its own contract: never write a rule.
    const settings = { bypassPermissions: true } as unknown as PersistedSettings;
    MIGRATIONS[0]!.migrate(settings);

    expect(settings.dangerouslySkipPermissions).toBe(true);
    expect(settings.permissions?.allow ?? []).toEqual([]);
    expect("bypassPermissions" in settings).toBe(false);
  });

  test("does not auto-approve a colon-bearing command", () => {
    // The bug the string hides, checked against the matcher that runs in
    // production. `curl <url>` is arbitrary network and `git push` is a push;
    // the old sentinel allowed both silently, and prompted for `rm -rf /`.
    const result = runMigrations({ bypassPermissions: true } as unknown as PersistedSettings);

    expect(autoApproves(result.settings, "curl https://example.com")).toBe(false);
    expect(autoApproves(result.settings, "git push origin HEAD:main")).toBe(false);
    expect(autoApproves(result.settings, "rm -rf /")).toBe(false);
  });

  test("a settings file without it gains nothing", () => {
    const result = runMigrations({ schemaVersion: 0 } as PersistedSettings);
    expect(result.settings.dangerouslySkipPermissions).toBeUndefined();
    expect(result.settings.permissions).toBeUndefined();
  });

  test("a stored false stays false", () => {
    const result = runMigrations({
      dangerouslySkipPermissions: false,
    } as PersistedSettings);
    expect(result.settings.dangerouslySkipPermissions).toBe(false);
  });
});

describe("repairing an install that already ran the old migration", () => {
  test("drops the sentinel and restores the opt-in it stood for", () => {
    const result = runMigrations({
      schemaVersion: 2,
      permissions: { allow: ["Bash(git status)", "Bash(*:**)"], deny: ["Read(./secrets/**)"] },
    } as PersistedSettings);

    // Only the sentinel goes; hand-written rules are not touched.
    expect(result.settings.permissions?.allow).toEqual(["Bash(git status)"]);
    expect(result.settings.permissions?.deny).toEqual(["Read(./secrets/**)"]);
    expect(result.settings.dangerouslySkipPermissions).toBe(true);
  });

  test("an install without the sentinel is left alone", () => {
    // The sentinel is the only record that this user ever opted out. Someone
    // who has an ordinary allow rule and never asked for bypass keeps asking
    // to be asked — the repair must not read "has permissions" as "wants none".
    const settings = {
      schemaVersion: 2,
      permissions: { allow: ["Bash(git status)"] },
    } as PersistedSettings;
    const result = runMigrations(settings);

    expect(result.settings.dangerouslySkipPermissions).toBeUndefined();
    expect(result.settings.permissions?.allow).toEqual(["Bash(git status)"]);
  });

  test("a colon command is not auto-approved by what is left behind", () => {
    const result = runMigrations({
      schemaVersion: 2,
      permissions: { allow: ["Bash(*:**)"] },
    } as PersistedSettings);

    expect(autoApproves(result.settings, "curl https://example.com")).toBe(false);
    // And the opt-out it was standing in for is intact.
    expect(result.settings.dangerouslySkipPermissions).toBe(true);
  });
});

describe("the chain", () => {
  test("runs from nothing to the current version", () => {
    const result = runMigrations({} as PersistedSettings);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(result.settings.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(result.errors).toEqual([]);
  });

  test("a current file is not migrated at all", () => {
    // `loadSettings` rewrites the file whenever anything applied, so a chain
    // that re-runs on every read is a write on every read.
    const result = runMigrations({ schemaVersion: LATEST_SCHEMA_VERSION } as PersistedSettings);
    expect(result.applied).toEqual([]);
  });

  test("a legacy flag survives the whole chain", () => {
    const result = runMigrations({
      schemaVersion: 0,
      bypassPermissions: true,
    } as unknown as PersistedSettings);

    expect(result.settings.dangerouslySkipPermissions).toBe(true);
    expect(result.settings.permissions?.allow ?? []).toEqual([]);
  });
});
