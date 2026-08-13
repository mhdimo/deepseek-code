




































import { createHash } from "crypto";
import { readFile, writeFile, mkdir, unlink, stat, readdir } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative } from "path";



const HISTORY_ROOT = join(homedir(), ".deepseek-code", "filehistory");
const BLOBS_DIR = join(HISTORY_ROOT, "blobs");
const MANIFESTS_DIR = join(HISTORY_ROOT, "manifests");

function manifestPath(messageIndex: number): string {
  return join(MANIFESTS_DIR, `${messageIndex}.json`);
}

function blobPath(digest: string): string {
  
  return join(BLOBS_DIR, digest.slice(0, 2), digest);
}




type Digest = string | null;


interface SnapshotManifest {
  messageIndex: number;
  timestamp: number;
  workingDir: string;
  
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
  
  await mkdir(BLOBS_DIR, { recursive: true });
  await mkdir(MANIFESTS_DIR, { recursive: true });
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


export function hasSnapshot(messageIndex: number): boolean {
  return existsSync(manifestPath(messageIndex));
}


export async function dropSnapshot(messageIndex: number): Promise<void> {
  const path = manifestPath(messageIndex);

  
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
      
    }
  }
  return refs;
}
