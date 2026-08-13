



























import type { PersistedSettings } from "../state/storage.js";




export interface Migration {
  
  fromVersion: number;
  
  toVersion: number;
  
  description: string;
  
  migrate: (settings: PersistedSettings) => PersistedSettings;
}




export const LATEST_SCHEMA_VERSION = 2;







function migrateBypassPermissionsIntoPermissions(
  settings: PersistedSettings,
): PersistedSettings {
  const legacy =
    (settings as unknown as Record<string, unknown>).bypassPermissions ??
    (settings as unknown as Record<string, unknown>).dangerouslySkipPermissions;

  if (legacy !== true) {
    
    if (!settings.permissions) settings.permissions = {};
    return settings;
  }

  const sentinel = "Bash(*:**)";
  const perms = settings.permissions ?? {};
  const allow = new Set(perms.allow ?? []);
  allow.add(sentinel);

  settings.permissions = {
    ...perms,
    allow: [...allow],
  };

  
  delete (settings as unknown as Record<string, unknown>).bypassPermissions;
  delete (settings as unknown as Record<string, unknown>).dangerouslySkipPermissions;

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
    description:
      "Fold legacy bypassPermissions/dangerouslySkipPermissions into the permissions object.",
    migrate: migrateBypassPermissionsIntoPermissions,
  },
  {
    fromVersion: 1,
    toVersion: 2,
    description: "Backfill and normalize cleanupPeriodDays to a positive default.",
    migrate: migrateNormalizeCleanupPeriodDays,
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
