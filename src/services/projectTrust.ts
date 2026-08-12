// Project trust service — gates untrusted directories from auto-injecting
// project context (CLAUDE.md / DEEP.md) or running project-local slash
// commands and skills.
//
// Trust is persisted as a flat JSON array of absolute directory paths in
// ~/.deepseek-code/trusted-dirs.json. A directory is considered trusted if it
// OR any of its ancestor directories appears in that list (so trusting a
// parent repo root also trusts nested worktrees/subprojects). This mirrors
// Claude Code's `checkHasTrustDialogAccepted()` walk, adapted to DeepSeek
// Code's flat-file storage convention (see src/state/storage.ts).
//
// Design notes:
//   - Pure TS; no React, no Ink. The TUI layer is responsible for rendering a
//     first-run trust dialog and calling trustDir()/untrustDir().
//   - File access is defensive: a corrupt or unreadable trusted-dirs.json is
//     treated as "no trusted dirs" rather than crashing startup.
//   - Path normalization uses realpath when available, falling back to the
//     resolved path so symlinks and trailing slashes don't fragment entries.
//   - The home directory is intentionally NEVER auto-trusted; the user must
//     explicitly opt in (matching Claude Code's home-dir behavior).

import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { join, resolve, sep } from "path";
import { homedir } from "os";

// ─── Paths ───────────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), ".deepseek-code");
const TRUSTED_DIRS_FILE = join(DATA_DIR, "trusted-dirs.json");

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Normalize a directory path for storage/comparison: resolve it absolutely,
 * resolve symlinks via realpath when the path exists, and strip a trailing
 * separator so "x" and "x/" compare equal.
 *
 * Returns the normalized path. Never throws — falls back to the resolved
 * (non-realpath) form if realpath fails (e.g. dir has been deleted).
 */
function normalizeDir(dir: string): string {
  const resolved = resolve(dir);
  try {
    const real = realpathSync(resolved);
    return stripTrailingSep(real);
  } catch {
    return stripTrailingSep(resolved);
  }
}

function stripTrailingSep(p: string): string {
  if (p.length <= 1) return p; // preserve "/"
  return p.endsWith(sep) ? p.slice(0, -1) : p;
}

/** Ensure ~/.deepseek-code/ exists (best-effort). */
function ensureDataDir(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    // best-effort; read paths below tolerate a missing dir
  }
}

/** Read the trusted-dirs array from disk. Returns [] on any failure. */
function readTrustedDirs(): string[] {
  try {
    if (!existsSync(TRUSTED_DIRS_FILE)) return [];
    const raw = readFileSync(TRUSTED_DIRS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .map((e) => {
        try {
          return normalizeDir(e);
        } catch {
          return stripTrailingSep(resolve(e));
        }
      });
  } catch {
    return [];
  }
}

/** Persist the trusted-dirs array to disk (atomic-ish; best-effort). */
function writeTrustedDirs(dirs: string[]): void {
  ensureDataDir();
  try {
    // Dedupe + sort for stable diffs.
    const unique = Array.from(new Set(dirs.map(stripTrailingSep))).sort();
    writeFileSync(TRUSTED_DIRS_FILE, JSON.stringify(unique, null, 2), "utf-8");
  } catch {
    // best-effort: a read-only HOME shouldn't crash the session
  }
}

/**
 * Walk up from `dir`, returning true if `dir` or any ancestor is in the
 * trusted set. This is the core trust predicate.
 */
function isDirOrAncestorTrusted(dir: string, trusted: ReadonlySet<string>): boolean {
  let current = normalizeDir(dir);
  // Guard against infinite loops on weird roots.
  for (;;) {
    if (trusted.has(current)) return true;
    const parent = stripTrailingSep(resolve(current, ".."));
    if (parent === current) return false; // reached filesystem root
    current = parent;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Return true if `cwd` (or any of its ancestor directories) has been
 * explicitly trusted by the user. Safe to call on every startup; reads are
 * cached per-process via a tiny memo that invalidates on mutation.
 */
export function isTrusted(cwd: string): boolean {
  const trusted = new Set(readTrustedDirs());
  return isDirOrAncestorTrusted(cwd, trusted);
}

/**
 * Mark `cwd` as trusted. Persists immediately. Idempotent. Returns the
 * normalized path that was recorded.
 */
export function trustDir(cwd: string): string {
  const normalized = normalizeDir(cwd);
  const dirs = readTrustedDirs();
  if (!dirs.includes(normalized)) {
    dirs.push(normalized);
    writeTrustedDirs(dirs);
  }
  return normalized;
}

/**
 * Remove `cwd` (exact match only — does NOT untrust ancestors) from the
 * trusted set. Idempotent. Returns true if an entry was actually removed.
 */
export function untrustDir(cwd: string): boolean {
  const normalized = normalizeDir(cwd);
  const dirs = readTrustedDirs();
  const next = dirs.filter((d) => d !== normalized);
  if (next.length === dirs.length) return false;
  writeTrustedDirs(next);
  return true;
}

/**
 * List the explicitly-trusted directory paths (normalized, sorted). Read-only
 * snapshot; useful for a future `/trust` management command.
 */
export function listTrustedDirs(): string[] {
  return readTrustedDirs().slice().sort();
}

/**
 * Whether the TUI should show the first-run trust dialog for `cwd`.
 *
 * Returns true when the directory is NOT currently trusted. The caller is
 * responsible for showing the dialog (once per trust decision) and calling
 * trustDir() on acceptance. This intentionally never auto-trusts, including
 * for the home directory — the user must opt in.
 */
export function shouldPromptTrust(cwd: string): boolean {
  return !isTrusted(cwd);
}

/**
 * Convenience: the on-disk path used for trusted-dirs storage. Exported so a
 * management command or diagnostics can surface where trust lives.
 */
export function getTrustedDirsFile(): string {
  return TRUSTED_DIRS_FILE;
}
