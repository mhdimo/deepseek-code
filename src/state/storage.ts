







import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, chmodSync } from "fs";
import { join } from "path";
import { dataDir } from "../utils/dataDir.js";



const settingsFile = (): string => join(dataDir(), "settings.json");
const sessionsDir = (): string => join(dataDir(), "sessions");
const historyFile = (): string => join(dataDir(), "history.json");
const MAX_HISTORY = 500;


// Everything under ~/.deepseek-code is the user's alone: settings.json holds the
// API key, sessions/ holds full transcripts of every file the agent has read,
// history.json holds every prompt typed. All of it used to be created with the
// process default — 0644 files in a 0755 directory under a normal umask, i.e.
// readable by every other account on the machine.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;




export type EffortLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

import type { ThemeSetting } from "../utils/theme.js";

export interface PersistedSettings {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  provider?: string;
  defaultAgent?: string;
  thinkingMode?: string;
  
  effort?: EffortLevel;
  
  themeMode?: ThemeSetting;
  
  onboarded?: boolean;
  
  lastSessionHash?: string;
  
  schemaVersion?: number;
  
  
  includeCoAuthoredBy?: boolean;
  
  cleanupPeriodDays?: number;
  
  spinnerTipsEnabled?: boolean;
  
  verbose?: boolean;
  
  outputStyle?: string;
  
  env?: Record<string, string>;
  
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };

  /**
   * The settings panel's "Skip Permissions" row. Read back by
   * `loadPersistedSettings` and refused at startup as root/sudo outside a
   * sandbox — see `services/bypassMode.ts`. It used to be written and never
   * read, which is how a deliberate opt-out turned into a prompt on the next
   * run with nothing on screen to say it had.
   */
  dangerouslySkipPermissions?: boolean;

  /** Lifecycle hook configuration (see services/hooks.ts). */
  hooks?: import("../services/hooks.js").HooksConfig;  
  statusLine?: { type: "command"; command: string; padding?: number };

  /** /copy picker: always copy the full response, skipping the picker. */
  copyFullResponse?: boolean;

  /** Agent teams (teammates + per-agent colors) managed via /teams. */
  teams?: import("../types/index.js").TeamConfig[];
  
  lsp?: LspSettings;
}


export type LspServerConfigEntry =
  | [command: string, args?: string[]]
  | {
      command: string;
      args?: string[];
      
      extensions?: string[];
      
      rootUri?: string;
      
      rootPath?: string;
      
      env?: Record<string, string>;
      
      initializationOptions?: Record<string, unknown>;
      
      startupTimeout?: number;
    };


export interface LspSettings {
  
  servers?: Record<string, LspServerConfigEntry>;
  
  roots?: Record<string, string>;
}

export interface SessionData {
  hash: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    timestamp?: number;
    isError?: boolean;
  }>;
  tokenUsage: number;
  model: string;
  agent: string;
  workingDirectory: string;
  createdAt: number;
  updatedAt: number;
  /** User-assigned session title (Ctrl+R rename in the session picker). */
  title?: string;
  /** Git branch at save time (branch filter in the session picker). */
  branch?: string;
  /**
   * Scope this session's file-history snapshots live under. Absent on sessions
   * saved before snapshots were scoped; those fall back to the session hash.
   */
  fileHistoryId?: string;
}



function ensureDataDir(): void {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (!existsSync(sessionsDir())) mkdirSync(sessionsDir(), { recursive: true, mode: DIR_MODE });
}


/** Write a file only the owner can read. `mode` applies at creation; existing
 *  files are handled by hardenDataDir(), which runs once at startup. */
function writePrivateFile(path: string, data: string): void {
  writeFileSync(path, data, { encoding: "utf-8", mode: FILE_MODE });
}


/**
 * Repair permissions on anything under ~/.deepseek-code that is readable beyond
 * the owner, and report what was fixed so the UI can say so.
 *
 * Repair rather than only writing correct modes going forward: an install from
 * before this change keeps its loose 0644/0755 permissions until something
 * happens to rewrite each file, and the whole point is the key and the
 * transcripts. Only ever removes bits — a file the user deliberately made
 * stricter is left alone.
 *
 * Called once at startup, so it is not in the hot path of loadSettings().
 */
/**
 * Strip group/other access from `path`, and report whether it changed anything.
 *
 * Never widens — `current & mode` only ever clears bits, so a file the user
 * deliberately made stricter stays that way. Returns false for a missing path
 * or a platform without POSIX modes (Windows).
 */
export function tightenPermissions(path: string, mode: number): boolean {
  try {
    const current = statSync(path).mode & 0o777;
    if ((current & ~mode & 0o777) === 0) return false;
    chmodSync(path, current & mode);
    return true;
  } catch {
    return false;
  }
}

let hardeningNotes: string[] = [];

export function hardenDataDir(): void {
  ensureDataDir();
  const fixed: string[] = [];
  const loose = (path: string, mode: number): void => {
    if (tightenPermissions(path, mode)) fixed.push(path);
  };

  // The directory mode is the one that matters — 0700 on ~/.deepseek-code gates
  // every file inside it whatever their own modes say. The rest is depth.
  loose(dataDir(), DIR_MODE);
  loose(sessionsDir(), DIR_MODE);
  loose(settingsFile(), FILE_MODE);
  loose(historyFile(), FILE_MODE);

  hardeningNotes = fixed.length
    ? [
        "Tightened permissions on ~/.deepseek-code — it was readable by other " +
          "accounts on this machine and holds your API key and session history:",
        ...fixed,
      ]
    : [];
}


/** One-shot read of what hardenDataDir() fixed, for the UI to report. */
export function takeHardeningNotes(): string[] {
  const notes = hardeningNotes;
  hardeningNotes = [];
  return notes;
}



// loadSettings() runs on EVERY tool invocation (permission rules, hooks,
// effort, statusline …). Reading + JSON.parse-ing the file each time meant
// dozens of synchronous disk hits per agent turn, stalling the UI thread.
// The cache is keyed by file mtime so external edits are still picked up;
// saveSettings invalidates it explicitly (same-tick rewrites otherwise
// share the mtime).
// Keyed by path as well as mtime: the path is no longer a constant (see
// dataDir()), and two different files can share an mtime.
let settingsCache: { path: string; mtimeMs: number; settings: PersistedSettings } | null = null;

export function loadSettings(): PersistedSettings {
  try {
    const path = settingsFile();
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return {};
    }
    if (settingsCache && settingsCache.path === path && settingsCache.mtimeMs === mtimeMs) {
      return settingsCache.settings;
    }
    const raw = readFileSync(path, "utf-8");
    const settings = JSON.parse(raw) as PersistedSettings;
    
    
    try {
      const { runMigrations } = require("../utils/migrations.js") as {
        runMigrations: (s: PersistedSettings) => { applied: string[] };
      };
      const result = runMigrations(settings);
      if (result.applied.length > 0) {
        ensureDataDir();
        writePrivateFile(settingsFile(), JSON.stringify(settings, null, 2));
      }
    } catch {
      
    }
    // Retention is destructive, so an impossible value is dropped rather than
    // obeyed: callers fall back to the default. 0 is the one that bites —
    // `now - 0 days` is a cutoff of *now*, so a stray 0 in settings.json took
    // every saved session with it at the next startup.
    const days = settings.cleanupPeriodDays;
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
      delete settings.cleanupPeriodDays;
    }

    settingsCache = { path, mtimeMs, settings };
    return settings;
  } catch {
    return {};
  }
}

export function saveSettings(settings: PersistedSettings): void {
  ensureDataDir();
  
  const existing = loadSettings();
  const merged = { ...existing, ...settings };
  writePrivateFile(settingsFile(), JSON.stringify(merged, null, 2));
  settingsCache = null;
}



export function loadHistory(): string[] {
  try {
    if (!existsSync(historyFile())) return [];
    const parsed = JSON.parse(readFileSync(historyFile(), "utf-8"));
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

export function saveHistory(entries: string[]): void {
  ensureDataDir();
  try {
    writePrivateFile(historyFile(), JSON.stringify(entries.slice(-MAX_HISTORY), null, 2));
  } catch {
    
  }
}


export function appendHistory(entry: string): string[] {
  const trimmed = entry.trim();
  if (!trimmed) return loadHistory();
  const list = loadHistory();
  if (list[list.length - 1] !== trimmed) list.push(trimmed);
  const capped = list.slice(-MAX_HISTORY);
  saveHistory(capped);
  return capped;
}




function generateSessionHash(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}


export function saveSession(session: Omit<SessionData, "hash" | "createdAt" | "updatedAt">): string {
  ensureDataDir();

  const hash = generateSessionHash();
  const now = Date.now();
  const data: SessionData = {
    ...session,
    hash,
    createdAt: now,
    updatedAt: now,
  };

  writePrivateFile(join(sessionsDir(), `${hash}.json`), JSON.stringify(data, null, 2));

  
  saveSettings({ lastSessionHash: hash });

  return hash;
}


export function updateSession(hash: string, updates: Partial<SessionData>): void {
  const filePath = join(sessionsDir(), `${hash}.json`);
  if (!existsSync(filePath)) return;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as SessionData;
    const updated = { ...data, ...updates, updatedAt: Date.now() };
    writePrivateFile(filePath, JSON.stringify(updated, null, 2));
  } catch {
    
  }
}


export function loadSession(hash: string): SessionData | null {
  const filePath = join(sessionsDir(), `${hash}.json`);
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}


export function listSessions(): SessionData[] {
  ensureDataDir();
  try {
    const files = readdirSync(sessionsDir())
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse(); 

    return files.map((f) => {
      try {
        const raw = readFileSync(join(sessionsDir(), f), "utf-8");
        return JSON.parse(raw) as SessionData;
      } catch {
        return null;
      }
    }).filter((s): s is SessionData => s !== null);
  } catch {
    return [];
  }
}


// Pruning used to go through listSessions(), which reads + JSON.parses
// EVERY session file — pruneOldSessions runs synchronously at startup and
// pruneSessions on every first save of a session. Session filenames are
// `<timestamp36>-<rand>.json` (creation-ordered) and files are rewritten on
// every update, so filename order and file mtime are accurate proxies that
// avoid touching file contents at all.
export function pruneSessions(keepCount = 50): void {
  ensureDataDir();
  try {
    const files = readdirSync(sessionsDir())
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length <= keepCount) return;
    for (const f of files.slice(keepCount)) {
      try {
        unlinkSync(join(sessionsDir(), f));
      } catch {
        
      }
    }
  } catch {
    
  }
}


export function pruneOldSessions(days = 30): number {
  // Nothing deleted here can be recovered, so refuse an impossible window:
  // `days = 0` puts the cutoff at "now" and takes every session with it, and
  // 0 is exactly what an emptied settings field used to persist. Callers pass
  // an already-sanitized value; this is the last line of defense.
  if (!Number.isFinite(days) || days <= 0) return 0;

  ensureDataDir();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const f of readdirSync(sessionsDir())) {
      if (!f.endsWith(".json")) continue;
      try {
        if (statSync(join(sessionsDir(), f)).mtimeMs < cutoff) {
          unlinkSync(join(sessionsDir(), f));
          removed++;
        }
      } catch {
        
      }
    }
  } catch {
    
  }
  return removed;
}


export function getDataDir(): string {
  return dataDir();
}
