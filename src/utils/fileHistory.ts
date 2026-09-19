




































import { createHash, randomUUID } from "crypto";
import { readFile, writeFile, mkdir, unlink, stat, readdir } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { dataDir } from "./dataDir.js";



const historyRoot = (): string => join(dataDir(), "filehistory");
const blobsDir = (): string => join(historyRoot(), "blobs");
const manifestsDir = (): string => join(historyRoot(), "manifests");

/**
 * Snapshots are keyed by message index, which restarts at 1 in every
 * conversation. They used to live at a single shared `manifests/<index>.json`,
 * so a second session overwrote the first's rewind points at the same index,
 * and `hasSnapshot` — a bare existsSync — offered them to whichever session
 * asked. Restoring then applied another conversation's file state, or deleted
 * files, in the current directory.
 *
 * Every session now gets its own directory, the way the reference keeps
 * `file-history/<sessionId>/`. The scope is set once per run via
 * setFileHistorySession; unset, it falls back to a per-process id, which is
 * still isolated — just not resumable.
 */
let sessionScope: string | null = null;

/** Session ids reach a path, so keep them to characters that cannot escape it. */
function safeScope(scope: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(scope)
    ? scope
    : createHash("sha256").update(scope).digest("hex").slice(0, 32);
}

/**
 * Point file history at a session. Call on resume with the id the session was
 * saved under, so its earlier rewind points stay reachable.
 */
export function setFileHistorySession(scope: string): void {
  sessionScope = safeScope(scope);
}

/** The scope in force, generating a per-process one if none was set. */
export function getFileHistorySession(): string {
  if (!sessionScope) sessionScope = randomUUID();
  return sessionScope;
}

/**
 * Give the next conversation its own scope, and return the new id.
 *
 * Without this a path that starts a new conversation keeps the previous
 * conversation's directory, and because the new conversation's indices restart
 * at 1, its first snapshots overwrite the earlier conversation's manifests —
 * resuming that conversation would then restore (or delete) files using another
 * conversation's snapshots. Call it wherever a conversation begins; a
 * conversation that is merely rebuilt (a model change, /compact, a fallback
 * retry) must NOT call it, since its rewind points are still its own.
 *
 * Synchronous on purpose: the caller decides what to do with the outgoing
 * scope, and that decision has to see a settled one.
 */
export function resetFileHistorySession(): string {
  sessionScope = randomUUID();
  return sessionScope;
}

function manifestPath(messageIndex: number, scope = getFileHistorySession()): string {
  return join(manifestsDir(), scope, `${messageIndex}.json`);
}

function blobPath(digest: string): string {
  
  return join(blobsDir(), digest.slice(0, 2), digest);
}




type Digest = string | null;


interface SnapshotManifest {
  messageIndex: number;
  timestamp: number;
  workingDir: string;
  /** Session the snapshot belongs to; also the directory it lives in. */
  sessionId?: string;

  files: Record<string, Digest>;
}

export interface RestoreEntry {
  
  path: string;
  
  content: string | null;
}

export interface SnapshotResult {
  messageIndex: number;
  
  stored: string[];
  
  absent: string[];
  
  failed: Array<{ path: string; error: string }>;
  
  newBlobs: number;
}




function trackingKey(workingDir: string, absPath: string): string {
  const rel = relative(workingDir, absPath);
  
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return absPath;
  }
  return rel;
}


function expandKey(workingDir: string, key: string): string {
  return isAbsolute(key) ? key : join(workingDir, key);
}


function digestContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function ensureDirs(): Promise<void> {

  await mkdir(blobsDir(), { recursive: true });
  await mkdir(join(manifestsDir(), getFileHistorySession()), { recursive: true });
}


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


async function writeBlobIfMissing(digest: string, content: string): Promise<boolean> {
  const path = blobPath(digest);
  
  try {
    await stat(path);
    return false; 
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e;
  }
  
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  return true;
}




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
    
    const abs = isAbsolute(inputPath)
      ? inputPath
      : join(workingDir, inputPath);
    const key = trackingKey(workingDir, abs);

    try {
      const content = await readTextOrNull(abs);
      if (content === null) {
        
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
    sessionId: getFileHistorySession(),
    files,
  };

  try {
    await writeFile(
      manifestPath(messageIndex),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
  } catch (e: unknown) {
    
    
    throw new Error(
      `fileHistory: failed to write manifest for message ${messageIndex}: ${(e as Error).message}`,
    );
  }

  return { messageIndex, stored, absent, failed, newBlobs };
}


export async function restoreSnapshot(
  messageIndex: number,
  workingDir: string,
): Promise<RestoreEntry[]> {
  const manifest = await readManifest(messageIndex);
  if (!manifest) return [];

  // Relative keys were recorded against the directory the snapshot was taken
  // in, so expanding them anywhere else restores — and for absent files,
  // deletes — paths this manifest never described. A snapshot from another
  // project must not be applied to this one.
  if (resolve(manifest.workingDir) !== resolve(workingDir)) return [];

  const entries: RestoreEntry[] = [];
  for (const [key, digest] of Object.entries(manifest.files)) {
    const abs = expandKey(workingDir, key);

    if (digest === null) {
      
      entries.push({ path: abs, content: null });
      continue;
    }

    try {
      const content = await readFile(blobPath(digest), "utf-8");
      entries.push({ path: abs, content });
    } catch (e: unknown) {
      
      
      
      if (isENOENT(e)) continue;
      throw e;
    }
  }

  return entries;
}


async function readManifest(messageIndex: number): Promise<SnapshotManifest | null> {
  try {
    const raw = await readFile(manifestPath(messageIndex), "utf-8");
    return JSON.parse(raw) as SnapshotManifest;
  } catch (e: unknown) {
    if (isENOENT(e)) return null;
    // A corrupt manifest is not worth failing a rewind over.
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

/**
 * Whether this message has a snapshot usable *here* — taken in `workingDir`,
 * so the rewind picker does not advertise a restore it would then refuse to
 * perform. The directory is required rather than optional: every caller has
 * one, and the omit-it-and-anything-counts version is the bug this guards.
 */
export function hasSnapshot(messageIndex: number, workingDir: string): boolean {
  const path = manifestPath(messageIndex);
  if (!existsSync(path)) return false;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf-8")) as SnapshotManifest;
    return resolve(manifest.workingDir) === resolve(workingDir);
  } catch {
    return false;
  }
}


export async function dropSnapshot(messageIndex: number, scope?: string): Promise<void> {
  const path = manifestPath(messageIndex, scope);


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
    if (isENOENT(e)) return;
    throw e;
  }

  await unlink(path);
  await collectUnreferencedBlobs(droppedDigests);
}

/** Delete the blobs in `digests` that no manifest anywhere still references. */
async function collectUnreferencedBlobs(digests: Set<string>): Promise<void> {
  if (digests.size === 0) return;

  const survivingDigests = await collectReferencedDigests();
  for (const digest of digests) {
    if (survivingDigests.has(digest)) continue;
    const bp = blobPath(digest);
    try {
      await unlink(bp);
    } catch (e: unknown) {
      if (!isENOENT(e)) throw e;
    }
  }
}


/**
 * Drop every snapshot in the CURRENT session (used on /clear): the message
 * index restarts, so old manifests would otherwise be orphaned — new snapshots
 * overwrite the same manifest filenames while the previously referenced blobs
 * (full file copies, sha256-deduped) are never garbage-collected, growing
 * ~/.deepseek-code/filehistory without bound.
 *
 * Scoped, unlike before: /clear restarts this conversation's indices, and an
 * unrelated conversation's rewind points are not ours to delete.
 *
 * `scope` defaults to the one in force. A caller that has already moved the
 * scope on (a new conversation) must pass the outgoing id explicitly — this
 * function awaits before it reads anything, so by then the current scope is
 * the new one and the discarded conversation's manifests would be missed.
 */
export async function dropAllSnapshots(scope = getFileHistorySession()): Promise<void> {
  await dropLegacyManifests();

  const dir = join(manifestsDir(), scope);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e: unknown) {
    if (isENOENT(e)) return;
    throw e;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const idx = Number(name.replace(/\.json$/, ""));
    if (Number.isInteger(idx) && idx >= 0) {
      await dropSnapshot(idx, scope);
    }
  }
}

/**
 * Manifests written before snapshots were scoped sit directly under
 * manifests/, keyed by message index with no session to attribute them to — a
 * given index was overwritten by whichever conversation snapshotted last.
 * Nothing can reach them now (every lookup goes through a session directory),
 * so they are pure garbage, and being unreachable they pin the blobs they
 * reference — full file copies — for good. /clear is what exists to stop the
 * store growing without bound, so it takes them with it.
 */
async function dropLegacyManifests(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(manifestsDir());
  } catch (e: unknown) {
    if (isENOENT(e)) return;
    throw e;
  }

  const digests = new Set<string>();
  for (const name of names) {
    // Session directories are readdir'd above too; they never end in .json.
    if (!name.endsWith(".json")) continue;
    const path = join(manifestsDir(), name);
    try {
      const manifest = JSON.parse(
        await readFile(path, "utf-8"),
      ) as SnapshotManifest;
      for (const d of Object.values(manifest.files)) {
        if (d !== null) digests.add(d);
      }
      await unlink(path);
    } catch (e: unknown) {
      if (isENOENT(e)) continue;
      // A corrupt or unreadable legacy manifest is still unreachable; drop it.
      if (e instanceof SyntaxError) {
        await unlink(path).catch(() => {});
        continue;
      }
      throw e;
    }
  }

  await collectUnreferencedBlobs(digests);
}

/** Every manifest file on disk, in every session, plus any left by older versions. */
async function listManifestFiles(dir: string = manifestsDir()): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e: unknown) {
    if (isENOENT(e)) return [];
    throw e;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listManifestFiles(full)));
    } else if (entry.name.endsWith(".json")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Digests still referenced by any session's manifests. Deliberately global:
 * blobs are content-addressed and shared, so a session must not collect a blob
 * another session still points at.
 */
async function collectReferencedDigests(): Promise<Set<string>> {
  const refs = new Set<string>();

  for (const file of await listManifestFiles()) {
    try {
      const raw = await readFile(file, "utf-8");
      const manifest = JSON.parse(raw) as SnapshotManifest;
      for (const d of Object.values(manifest.files)) {
        if (d !== null) refs.add(d);
      }
    } catch {

    }
  }
  return refs;
}
