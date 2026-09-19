



























import type { PersistedSettings } from "../state/storage.js";




export interface Migration {
  
  fromVersion: number;
  
  toVersion: number;
  
  description: string;
  
  migrate: (settings: PersistedSettings) => PersistedSettings;
}




export const LATEST_SCHEMA_VERSION = 3;







/**
 * The rule this migration used to install in place of the flag. Named here
 * because the repair below has to recognise it, and because nothing else has
 * ever written this string — which is what makes its presence usable as
 * evidence of what happened to an install.
 */
const LEGACY_BYPASS_SENTINEL = "Bash(*:**)";

/**
 * A legacy "stop asking me" opt-in stays an opt-in — carried by the flag the
 * app actually reads, never by a permission rule.
 *
 * This used to delete the flag and add `Bash(*:**)` to `permissions.allow`,
 * which does not mean what it looks like. `matchShellCommand` sees no `prefix:*`
 * form in it, so it falls through to the wildcard matcher, which compiles the
 * two stars to `.*` and leaves the colon alone: the rule is `^.*:.*.*$`. It
 * auto-approves every command *containing a colon* — `curl https://…`,
 * `git push origin HEAD:main` — and prompts for every other command, including
 * plain `rm -rf /`. So the one setting whose entire meaning is "never ask me"
 * was discarded and mis-granted in the same step, in the direction that grants
 * authority rather than the one that prompts.
 *
 * `dangerouslySkipPermissions` is the same grant in the form the rest of the
 * app understands: read into the config by `loadPersistedSettings`, honoured by
 * the permission callback, and refused outright as root outside a sandbox
 * (`services/bypassMode.ts`). Nothing needs translating into rules, and a rule
 * is the one place this grant should never live — a rule outlives the decision,
 * is matched against every command, and cannot be revoked from the UI.
 */
function migrateBypassFlagToItsOwnKey(settings: PersistedSettings): PersistedSettings {
  const legacy = (settings as unknown as Record<string, unknown>).bypassPermissions;
  if (legacy === true) settings.dangerouslySkipPermissions = true;
  delete (settings as unknown as Record<string, unknown>).bypassPermissions;
  return settings;
}

/**
 * Undo the rule the old 0→1 left behind, for installs that already ran it.
 *
 * Two halves, and the second one is a judgement call worth stating. Removing
 * the rule is unambiguously right: it is over-broad in a way nobody asked for,
 * and a missing allow rule only means a prompt comes back. But removing it
 * alone would silently hand prompts back to someone who had turned them off,
 * with no signal and no explanation — so the flag is restored alongside it.
 *
 * That is a restoration, not a new grant: the sentinel is the fingerprint of a
 * user who had opted out (this migration chain is the only thing that has ever
 * written it), and `dangerouslySkipPermissions: true` in their settings.json is
 * exactly what that opt-out was before the old migration ate it. The result is
 * also strictly narrower than what they have today — the flag is refused
 * entirely as root outside a sandbox, and still prompts for protected paths,
 * neither of which the rule did.
 */
function migrateRepairBypassSentinel(settings: PersistedSettings): PersistedSettings {
  const perms = settings.permissions;
  const allow = perms?.allow;
  if (!perms || !allow || !allow.includes(LEGACY_BYPASS_SENTINEL)) return settings;

  settings.permissions = {
    ...perms,
    allow: allow.filter((rule) => rule !== LEGACY_BYPASS_SENTINEL),
  };
  settings.dangerouslySkipPermissions = true;
  return settings;
}


function migrateNormalizeCleanupPeriodDays(
  settings: PersistedSettings,
): PersistedSettings {
  const raw = settings.cleanupPeriodDays;
  const DEFAULT = 30;

  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    settings.cleanupPeriodDays = DEFAULT;
  }
  return settings;
}


export const MIGRATIONS: Migration[] = [
  {
    fromVersion: 0,
    toVersion: 1,
    description: "Move a legacy bypassPermissions opt-in onto dangerouslySkipPermissions.",
    migrate: migrateBypassFlagToItsOwnKey,
  },
  {
    fromVersion: 1,
    toVersion: 2,
    description: "Backfill and normalize cleanupPeriodDays to a positive default.",
    migrate: migrateNormalizeCleanupPeriodDays,
  },
  {
    fromVersion: 2,
    toVersion: 3,
    description:
      "Replace the over-broad Bash allow rule left by the old bypass migration with the flag it stood in for.",
    migrate: migrateRepairBypassSentinel,
  },
];



export interface MigrationResult {
  
  settings: PersistedSettings;
  
  fromVersion: number;
  
  toVersion: number;
  
  applied: string[];
  
  errors: Array<{ fromVersion: number; error: string }>;
}


export function readSchemaVersion(settings: PersistedSettings): number {
  const raw = (settings as unknown as { schemaVersion?: unknown }).schemaVersion;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const v = Math.trunc(raw);
  if (v < 0) return 0;
  if (v > LATEST_SCHEMA_VERSION) return LATEST_SCHEMA_VERSION;
  return v;
}


export function runMigrations(settings: PersistedSettings): MigrationResult {
  const fromVersion = readSchemaVersion(settings);
  const applied: string[] = [];
  const errors: Array<{ fromVersion: number; error: string }> = [];

  let current = fromVersion;

  for (const migration of MIGRATIONS) {
    if (current < migration.fromVersion) {
      
      
      break;
    }
    if (current >= migration.toVersion) {
      continue; 
    }
    if (migration.fromVersion !== current) {
      
      
      break;
    }

    try {
      migration.migrate(settings);
      applied.push(migration.description);
      current = migration.toVersion;
    } catch (err) {
      errors.push({
        fromVersion: migration.fromVersion,
        error: err instanceof Error ? err.message : String(err),
      });
      
      
      break;
    }
  }

  
  
  
  (settings as unknown as { schemaVersion: number }).schemaVersion =
    LATEST_SCHEMA_VERSION;

  return {
    settings,
    fromVersion,
    toVersion: LATEST_SCHEMA_VERSION,
    applied,
    errors,
  };
}
