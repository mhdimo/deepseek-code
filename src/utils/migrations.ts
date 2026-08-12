// Config/settings migration framework.
//
// A registry of idempotent migrations keyed by schema version. Each migration
// transforms a PersistedSettings object from version N to version N+1.
// `runMigrations(settings)` applies every pending migration in order, bumps
// `settings.schemaVersion` to the latest, and returns the migrated object.
//
// Design (adapted from Claude Code's per-function migration pattern, but made
// version-keyed and idempotent for DeepSeek's single PersistedSettings object):
//
//   - Each migration is a pure function: (settings) => settings. It MUST be
//     idempotent (running it twice yields the same result) so that re-runs
//     after a crash mid-write are safe.
//   - Migrations are addressed by the version they upgrade *from*. The entry
//     at index i upgrades version i -> i+1. The runner walks from the
//     settings' current schemaVersion up to LATEST_SCHEMA_VERSION.
//   - The runner never throws on a failed migration: it logs the error and
//     keeps going, then still stamps the schemaVersion so a corrupt migration
//     doesn't loop forever on every startup. (Best-effort, like storage.ts.)
//   - A settings object with no `schemaVersion` is treated as version 0
//     (pre-versioning), so all existing users get migrated up cleanly.
//
// Integration (see sharedFileWiring in the task output): the caller should
// `runMigrations(loadSettings())` once at startup (e.g. in storage.loadSettings
// or index.tsx) and persist the result before the rest of the app reads it.
//
// This module is pure TS and has no side effects beyond mutating its argument.

import type { PersistedSettings } from "../state/storage.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A single idempotent migration. Upgrades settings from `fromVersion` to
 * `toVersion`. Must be safe to run more than once.
 */
export interface Migration {
  /** Schema version this migration upgrades FROM. */
  fromVersion: number;
  /** Schema version this migration upgrades TO (fromVersion + 1). */
  toVersion: number;
  /** Human-readable description, surfaced in logs/migration summaries. */
  description: string;
  /**
   * The transform. Receives the settings object (already at fromVersion) and
   * returns the migrated settings (now at toVersion). Implementations should
   * mutate-and-return the same object for efficiency, but may return a new one.
   */
  migrate: (settings: PersistedSettings) => PersistedSettings;
}

// ─── The current schema version ─────────────────────────────────────────────

/**
 * The newest schema version known to this build. Settings with a lower
 * `schemaVersion` (or none at all) are migrated up to this number by
 * `runMigrations`. Bump this when you append a new Migration to MIGRATIONS.
 */
export const LATEST_SCHEMA_VERSION = 2;

// ─── Migrations ─────────────────────────────────────────────────────────────
//
// Append-only. The migration at index i must have fromVersion === i so the
// runner can chain them 0 -> 1 -> 2 -> ... unambiguously.

/**
 * v0 -> v1: Fold the legacy top-level `bypassPermissions` /
 * `dangerouslySkipPermissions` boolean into the structured `permissions` object.
 *
 * Older builds stored the "skip all permission prompts" preference as a bare
 * boolean at the root. The current shape uses a `permissions` object (allow /
 * deny / ask rules), so we normalize the legacy flag into a sentinel allow rule
 * and drop the deprecated keys. Idempotent: if there is no legacy flag, or the
 * sentinel already exists, it's a no-op.
 */
function migrateBypassPermissionsIntoPermissions(
  settings: PersistedSettings,
): PersistedSettings {
  const legacy =
    (settings as unknown as Record<string, unknown>).bypassPermissions ??
    (settings as unknown as Record<string, unknown>).dangerouslySkipPermissions;

  if (legacy !== true) {
    // Nothing to migrate; just ensure the permissions object exists.
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

  // Drop the deprecated keys so they don't linger / confuse downstream readers.
  delete (settings as unknown as Record<string, unknown>).bypassPermissions;
  delete (settings as unknown as Record<string, unknown>).dangerouslySkipPermissions;

  return settings;
}

/**
 * v1 -> v2: Backfill `cleanupPeriodDays` default and normalize out-of-range
 * values. Pure shape/normalization migration — useful as the second example
 * because it shows the "set a sensible default when absent" pattern without
 * touching semantics.
 *
 * Idempotent: once the field is a positive finite number it is left alone.
 */
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

/**
 * Ordered list of all migrations, indexed by the version they upgrade FROM.
 * The runner assumes MIGRATIONS[i].fromVersion === i.
 */
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

// ─── Runner ─────────────────────────────────────────────────────────────────

export interface MigrationResult {
  /** The migrated settings (same object passed in, mutated in place). */
  settings: PersistedSettings;
  /** The schema version the settings started at. */
  fromVersion: number;
  /** The schema version the settings ended at. */
  toVersion: number;
  /** Descriptions of the migrations that were actually applied. */
  applied: string[];
  /** Non-fatal errors keyed by the from-version that failed. Never thrown. */
  errors: Array<{ fromVersion: number; error: string }>;
}

/**
 * Read the schema version off a settings object, treating missing/non-finite
 * values as 0 (pre-versioning). Negative or absurdly large values are clamped
 * to [0, LATEST_SCHEMA_VERSION] so a corrupt stamp can't wedge the runner.
 */
export function readSchemaVersion(settings: PersistedSettings): number {
  const raw = (settings as unknown as { schemaVersion?: unknown }).schemaVersion;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const v = Math.trunc(raw);
  if (v < 0) return 0;
  if (v > LATEST_SCHEMA_VERSION) return LATEST_SCHEMA_VERSION;
  return v;
}

/**
 * Apply all pending migrations to `settings`, in order, and stamp
 * `schemaVersion` to LATEST_SCHEMA_VERSION.
 *
 * - Idempotent: calling it again on an already-migrated object applies nothing.
 * - Never throws: a failing migration is recorded in `result.errors` and the
 *   runner advances past it (stamping the version anyway) so a single bad
 *   migration can't block every subsequent startup.
 *
 * @param settings the loaded settings (mutated in place and returned)
 * @returns a {@link MigrationResult} describing what happened
 */
export function runMigrations(settings: PersistedSettings): MigrationResult {
  const fromVersion = readSchemaVersion(settings);
  const applied: string[] = [];
  const errors: Array<{ fromVersion: number; error: string }> = [];

  let current = fromVersion;

  for (const migration of MIGRATIONS) {
    if (current < migration.fromVersion) {
      // A prior migration in the chain failed (or was missing); we can't safely
      // skip ahead. Stamp the version to avoid a restart loop and stop.
      break;
    }
    if (current >= migration.toVersion) {
      continue; // already at or past this migration
    }
    if (migration.fromVersion !== current) {
      // Gap in the chain (shouldn't happen given the append-only invariant).
      // Stop rather than apply out-of-order.
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
      // Do NOT advance `current`; the loop's `current < fromVersion` guard on
      // the next iteration will break out. We still stamp schemaVersion below.
      break;
    }
  }

  // Always stamp the latest version so a transient error doesn't cause the
  // same migration to be retried on every startup (it would no-op anyway if
  // idempotent, but stamping avoids redundant work and log noise).
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
