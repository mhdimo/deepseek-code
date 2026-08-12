// fileHistory.ts — on-disk file content snapshots for /rewind
//
// Adapted from Claude Code's src/utils/fileHistory.ts, but stripped down to a
// pure-TS, stateless module that fits DeepSeek Code's architecture (the C++
// backend owns the agent loop; this is a self-contained helper the TS side
// calls around file-mutating tools).
//
// Model
// ────
// Snapshots are keyed by conversation message index (a monotonically
// increasing integer that the caller — typically App.tsx / the query engine —
// derives from `messages.length` at the point a user turn begins).
//
// Storage layout (all under ~/.deepseek-code/filehistory/):
//
//   blobs/<sha256-hex>          ← raw file contents, content-addressed.
//                                  Two snapshots of an unchanged file share
//                                  one blob — git-blob-style dedup for free.
//   manifests/<msgIndex>.json   ← { messageIndex, timestamp, workingDir,
//                                   files: { [relPath]: digest | null } }
//                                  A `null` digest means the file did NOT
//                                  exist at this snapshot (deletion marker),
//                                  so restore can unlink it.
//
// The manifest stores paths relative to workingDir when possible (compact +
// relocatable); absolute paths outside the working directory are stored as-is.
//
// Public API
// ────
//   snapshotFiles(messageIndex, filePaths, workingDir): Promise<SnapshotResult>
//   restoreSnapshot(messageIndex, workingDir): Promise<RestoreEntry[]>
//   hasSnapshot(messageIndex): boolean
//   dropSnapshot(messageIndex): Promise<void>
//
// All IO is async and best-effort: a per-file failure does not abort the whole
// snapshot/restore — the entry is skipped and reported in the result.

import { createHash } from "crypto";
import { readFile, writeFile, mkdir, unlink, stat, readdir } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative } from "path";

// ─── Paths ────────────────────────────────────────────────────────────────────

const HISTORY_ROOT = join(homedir(), ".deepseek-code", "filehistory");
const BLOBS_DIR = join(HISTORY_ROOT, "blobs");
const MANIFESTS_DIR = join(HISTORY_ROOT, "manifests");

function manifestPath(messageIndex: number): string {
  return join(MANIFESTS_DIR, `${messageIndex}.json`);
}

function blobPath(digest: string): string {
  // Shard blobs by the first 2 hex chars to avoid one giant directory.
  return join(BLOBS_DIR, digest.slice(0, 2), digest);
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** A null digest marks a file that did not exist at snapshot time. */
type Digest = string | null;

/** Serialized to disk as manifests/<msgIndex>.json. */
interface SnapshotManifest {
  messageIndex: number;
  timestamp: number;
  workingDir: string;
  /** relPath (or absolute path if outside cwd) → content digest. */
  files: Record<string, Digest>;
}

export interface RestoreEntry {
  /** Absolute path the caller should write `content` back to. */
  path: string;
  /** File content to write, or `null` to DELETE the file (deletion marker). */
  content: string | null;
}

export interface SnapshotResult {
  messageIndex: number;
  /** Absolute paths actually snapshotted (existing files only). */
  stored: string[];
  /** Absolute paths recorded as absent at snapshot time. */
  absent: string[];
  /** Absolute paths that failed to snapshot, with the error message. */
  failed: Array<{ path: string; error: string }>;
  /** Total number of NEW blobs written (unchanged files reuse blobs → 0). */
  newBlobs: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Normalize a tracked file path to a compact, relocatable key.
 * Relative to workingDir when the file lives under it; absolute otherwise.
 */
function trackingKey(workingDir: string, absPath: string): string {
  const rel = relative(workingDir, absPath);
  // `relative` returns "" for the cwd itself and keeps ".." for paths outside.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return absPath;
  }
  return rel;
}

/** Convert a tracking key back to an absolute path. */
function expandKey(workingDir: string, key: string): string {
  return isAbsolute(key) ? key : join(workingDir, key);
}

/** sha256 hex digest of UTF-8 content. */
function digestContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function ensureDirs(): Promise<void> {
  // mkdir -p is idempotent; calling per snapshot is cheap.
  await mkdir(BLOBS_DIR, { recursive: true });
  await mkdir(MANIFESTS_DIR, { recursive: true });
}

/** Read a file as UTF-8, or return null if it does not exist. */
async function readTextOrNull(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, "utf-8");
  } catch (e: unknown) {
    if (isENOENT(e)) return null;
    throw e;
  }
}

function isENOENT(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Persist a blob unless it already exists on disk (content-addressed dedup).
 * Returns true if a new blob file was created.
 */
async function writeBlobIfMissing(digest: string, content: string): Promise<boolean> {
  const path = blobPath(digest);
  // Fast path: stat first. sha256 collisions are not a concern here.
  try {
    await stat(path);
    return false; // already present
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e;
  }
  // Lazy mkdir: only create the shard dir when actually writing.
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  return true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Snapshot the on-disk contents of `filePaths` at conversation `messageIndex`.
 *
 * - Files that do not exist are recorded with a `null` digest (deletion
 *   marker), so a later restore can remove them.
 * - Files whose content already matches an existing blob reuse that blob
 *   (git-blob-style dedup) — no duplicate bytes are written.
 * - Overwrites any prior manifest for the same messageIndex.
 *
 * Paths in `filePaths` may be absolute or relative to `workingDir`; they are
 * resolved and stored as compact tracking keys.
 */
export async function snapshotFiles(
  messageIndex: number,
  filePaths: readonly string[],
  workingDir: string,
): Promise<SnapshotResult> {
  await ensureDirs();

  const files: Record<string, Digest> = {};
  const stored: string[] = [];
  const absent: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  let newBlobs = 0;

  for (const inputPath of filePaths) {
    // Resolve to absolute, then to a compact tracking key.
    const abs = isAbsolute(inputPath)
      ? inputPath
      : join(workingDir, inputPath);
    const key = trackingKey(workingDir, abs);

    try {
      const content = await readTextOrNull(abs);
      if (content === null) {
        // File does not exist right now → record a deletion marker.
        files[key] = null;
        absent.push(abs);
        continue;
      }

      const digest = digestContent(content);
      const createdNew = await writeBlobIfMissing(digest, content);
      if (createdNew) newBlobs++;

      files[key] = digest;
      stored.push(abs);
    } catch (e: unknown) {
      failed.push({ path: abs, error: (e as Error).message });
    }
  }

  const manifest: SnapshotManifest = {
    messageIndex,
    timestamp: Date.now(),
    workingDir,
    files,
  };

  try {
    await writeFile(
      manifestPath(messageIndex),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
  } catch (e: unknown) {
    // If the manifest can't be written, the snapshot is unusable — surface it
    // as a failure of the whole call rather than silently succeeding.
    throw new Error(
      `fileHistory: failed to write manifest for message ${messageIndex}: ${(e as Error).message}`,
    );
  }

  return { messageIndex, stored, absent, failed, newBlobs };
}

/**
 * Load the snapshot for `messageIndex` and resolve every tracked file back to
 * { path, content } entries the caller can apply.
 *
 * - Entries with a real digest carry the snapshotted content.
 * - Entries with a `null` digest carry `content: null` (caller should DELETE).
 * - `workingDir` is used to re-expand relative tracking keys. If the snapshot
 *   was taken in a different workingDir, absolute keys still resolve; relative
 *   keys resolve against the workingDir you pass in (intentional — the caller
 *   decides what "here" means).
 *
 * Does NOT write to disk. Returns [] if no snapshot exists for the index.
 */
export async function restoreSnapshot(
  messageIndex: number,
  workingDir: string,
): Promise<RestoreEntry[]> {
  const path = manifestPath(messageIndex);
  let manifest: SnapshotManifest;
  try {
    const raw = await readFile(path, "utf-8");
    manifest = JSON.parse(raw) as SnapshotManifest;
  } catch (e: unknown) {
    if (isENOENT(e)) return [];
    throw e;
  }

  const entries: RestoreEntry[] = [];
  for (const [key, digest] of Object.entries(manifest.files)) {
    const abs = expandKey(workingDir, key);

    if (digest === null) {
      // Deletion marker — restore means "remove this file if present".
      entries.push({ path: abs, content: null });
      continue;
    }

    try {
      const content = await readFile(blobPath(digest), "utf-8");
      entries.push({ path: abs, content });
    } catch (e: unknown) {
      // Blob missing from the store — skip rather than corrupt the restore.
      // (Treat as best-effort: a missing blob is not a reason to abort the
      // whole rewind.)
      if (isENOENT(e)) continue;
      throw e;
    }
  }

  return entries;
}

/** Whether a snapshot manifest exists for the given message index. */
export function hasSnapshot(messageIndex: number): boolean {
  return existsSync(manifestPath(messageIndex));
}

/**
 * Delete the manifest and any now-orphan blobs for `messageIndex`.
 *
 * Orphan detection: after removing this manifest, scan the remaining manifests
 * for any reference to each blob; blobs referenced by no manifest are deleted.
 * This keeps the blob store from growing without bound across many rewinds,
 * while never deleting a blob still needed by another snapshot.
 */
export async function dropSnapshot(messageIndex: number): Promise<void> {
  const path = manifestPath(messageIndex);

  // Capture the digests this snapshot referenced before deleting it.
  let droppedDigests: Set<string> = new Set();
  try {
    const raw = await readFile(path, "utf-8");
    const manifest = JSON.parse(raw) as SnapshotManifest;
    droppedDigests = new Set(
      Object.values(manifest.files).filter(
        (d): d is string => d !== null,
      ),
    );
  } catch (e: unknown) {
    if (isENOENT(e)) return; // nothing to drop
    throw e;
  }

  await unlink(path);

  // Garbage-collect blobs no longer referenced by any manifest.
  if (droppedDigests.size === 0) return;

  const survivingDigests = await collectReferencedDigests();
  for (const digest of droppedDigests) {
    if (survivingDigests.has(digest)) continue;
    const bp = blobPath(digest);
    try {
      await unlink(bp);
    } catch (e: unknown) {
      if (!isENOENT(e)) throw e;
    }
  }
}

/** Scan all manifests and return the set of digests they still reference. */
async function collectReferencedDigests(): Promise<Set<string>> {
  const refs = new Set<string>();
  let names: string[];
  try {
    names = await readdir(MANIFESTS_DIR);
  } catch (e: unknown) {
    if (isENOENT(e)) return refs;
    throw e;
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(MANIFESTS_DIR, name), "utf-8");
      const manifest = JSON.parse(raw) as SnapshotManifest;
      for (const d of Object.values(manifest.files)) {
        if (d !== null) refs.add(d);
      }
    } catch {
      // Skip corrupt/unreadable manifests rather than failing GC.
    }
  }
  return refs;
}
