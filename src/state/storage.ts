







import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";



const DATA_DIR = join(homedir(), ".deepseek-code");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const HISTORY_FILE = join(DATA_DIR, "history.json");
const MAX_HISTORY = 500;




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
}



function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}



// loadSettings() runs on EVERY tool invocation (permission rules, hooks,
// effort, statusline …). Reading + JSON.parse-ing the file each time meant
// dozens of synchronous disk hits per agent turn, stalling the UI thread.
// The cache is keyed by file mtime so external edits are still picked up;
// saveSettings invalidates it explicitly (same-tick rewrites otherwise
// share the mtime).
let settingsCache: { mtimeMs: number; settings: PersistedSettings } | null = null;

export function loadSettings(): PersistedSettings {
  try {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(SETTINGS_FILE).mtimeMs;
    } catch {
      return {};
    }
    if (settingsCache && settingsCache.mtimeMs === mtimeMs) {
      return settingsCache.settings;
    }
    const raw = readFileSync(SETTINGS_FILE, "utf-8");
    const settings = JSON.parse(raw) as PersistedSettings;
    
    
    try {
      const { runMigrations } = require("../utils/migrations.js") as {
        runMigrations: (s: PersistedSettings) => { applied: string[] };
      };
      const result = runMigrations(settings);
      if (result.applied.length > 0) {
        ensureDataDir();
        writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
      }
    } catch {
      
    }
    settingsCache = { mtimeMs, settings };
    return settings;
  } catch {
    return {};
  }
}

export function saveSettings(settings: PersistedSettings): void {
  ensureDataDir();
  
  const existing = loadSettings();
  const merged = { ...existing, ...settings };
  writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), "utf-8");
  settingsCache = null;
}



export function loadHistory(): string[] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const parsed = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

export function saveHistory(entries: string[]): void {
  ensureDataDir();
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(entries.slice(-MAX_HISTORY), null, 2), "utf-8");
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

  writeFileSync(join(SESSIONS_DIR, `${hash}.json`), JSON.stringify(data, null, 2), "utf-8");

  
  saveSettings({ lastSessionHash: hash });

  return hash;
}


export function updateSession(hash: string, updates: Partial<SessionData>): void {
  const filePath = join(SESSIONS_DIR, `${hash}.json`);
  if (!existsSync(filePath)) return;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as SessionData;
    const updated = { ...data, ...updates, updatedAt: Date.now() };
    writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf-8");
  } catch {
    
  }
}


export function loadSession(hash: string): SessionData | null {
  const filePath = join(SESSIONS_DIR, `${hash}.json`);
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
    const files = readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse(); 

    return files.map((f) => {
      try {
        const raw = readFileSync(join(SESSIONS_DIR, f), "utf-8");
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
    const files = readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length <= keepCount) return;
    for (const f of files.slice(keepCount)) {
      try {
        unlinkSync(join(SESSIONS_DIR, f));
      } catch {
        
      }
    }
  } catch {
    
  }
}


export function pruneOldSessions(days = 30): number {
  ensureDataDir();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const f of readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        if (statSync(join(SESSIONS_DIR, f)).mtimeMs < cutoff) {
          unlinkSync(join(SESSIONS_DIR, f));
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
  return DATA_DIR;
}
