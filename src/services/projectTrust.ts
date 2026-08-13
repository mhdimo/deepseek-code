




















import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { join, resolve, sep } from "path";
import { homedir } from "os";



const DATA_DIR = join(homedir(), ".deepseek-code");
const TRUSTED_DIRS_FILE = join(DATA_DIR, "trusted-dirs.json");




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
  if (p.length <= 1) return p; 
  return p.endsWith(sep) ? p.slice(0, -1) : p;
}


function ensureDataDir(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    
  }
}


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


function writeTrustedDirs(dirs: string[]): void {
  ensureDataDir();
  try {
    
    const unique = Array.from(new Set(dirs.map(stripTrailingSep))).sort();
    writeFileSync(TRUSTED_DIRS_FILE, JSON.stringify(unique, null, 2), "utf-8");
  } catch {
    
  }
}


function isDirOrAncestorTrusted(dir: string, trusted: ReadonlySet<string>): boolean {
  let current = normalizeDir(dir);
  
  for (;;) {
    if (trusted.has(current)) return true;
    const parent = stripTrailingSep(resolve(current, ".."));
    if (parent === current) return false; 
    current = parent;
  }
}




export function isTrusted(cwd: string): boolean {
  const trusted = new Set(readTrustedDirs());
  return isDirOrAncestorTrusted(cwd, trusted);
}


export function trustDir(cwd: string): string {
  const normalized = normalizeDir(cwd);
  const dirs = readTrustedDirs();
  if (!dirs.includes(normalized)) {
    dirs.push(normalized);
    writeTrustedDirs(dirs);
  }
  return normalized;
}


export function untrustDir(cwd: string): boolean {
  const normalized = normalizeDir(cwd);
  const dirs = readTrustedDirs();
  const next = dirs.filter((d) => d !== normalized);
  if (next.length === dirs.length) return false;
  writeTrustedDirs(next);
  return true;
}


export function listTrustedDirs(): string[] {
  return readTrustedDirs().slice().sort();
}


export function shouldPromptTrust(cwd: string): boolean {
  return !isTrusted(cwd);
}


export function getTrustedDirsFile(): string {
  return TRUSTED_DIRS_FILE;
}
