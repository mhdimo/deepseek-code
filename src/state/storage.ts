// Persistent storage — ~/.deepseek-code/ directory
//
// Manages:
//   settings.json  — persisted user settings (key, model, baseURL, etc.)
//   sessions/      — conversation history, one file per session
//
// Settings priority: settings.json > CLI args > env vars > .deepseek-code.json > defaults

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Paths ──────────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), ".deepseek-code");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const HISTORY_FILE = join(DATA_DIR, "history.json");
const MAX_HISTORY = 500;

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * User-facing reasoning-effort level, sent to OpenAI-compatible providers
 * (e.g. DeepSeek) as `reasoning_effort` via providerOptions. "off"/unset means
 * the provider default — behavior unchanged.
 */
export type EffortLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

import type { ThemeSetting } from "../utils/theme.js";

export interface PersistedSettings {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  provider?: string;
  defaultAgent?: string;
  thinkingMode?: string;
  /** Reasoning effort sent to OpenAI-compatible providers ("off"/unset = provider default). */
  effort?: EffortLevel;
  /** Theme preference — any ThemeSetting (auto/dark/light/daltonized/ANSI). */
  themeMode?: ThemeSetting;
  /** First-time setup (Onboarding) has been completed at least once. */
  onboarded?: boolean;
  /** The hash of the last active session (for resume) */
  lastSessionHash?: string;
  /** Settings schema version, managed by utils/migrations.ts runMigrations(). */
  schemaVersion?: number;
  // ── Claude-style settings ──────────────────────────────────────────────
  /** Add a Co-Authored-By trailer to /commit messages (default false). */
  includeCoAuthoredBy?: boolean;
  /** Delete saved sessions older than N days on startup (default 30). */
  cleanupPeriodDays?: number;
  /** Show the spinner tip/elapsed line (default true). */
  spinnerTipsEnabled?: boolean;
  /** Verbose/debug logging (default false). */
  verbose?: boolean;
  /** Default output style label (default "default"). */
  outputStyle?: string;
  /** Environment variables injected into the session/tool environment. */
  env?: Record<string, string>;
  /** Tool permission rules: allow / deny / ask (Tool(spec:pattern) syntax). */
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  /**
   * Custom status line (Claude Code parity): when set, the status bar runs
   * `command` (trust-gated, 5s timeout) and renders its trimmed stdout
   * right-aligned at the far edge. Managed via /statusline.
   */
  statusLine?: { type: "command"; command: string };
  /** LSP (Language Server Protocol) integration — see LspSettings. */
  lsp?: LspSettings;
}

/**
 * One configured language server. Either a [command, args?] tuple (canonical
 * short form) or an object form with extras (extensions, root, env, …).
 */
export type LspServerConfigEntry =
  | [command: string, args?: string[]]
  | {
      command: string;
      args?: string[];
      /** File extensions this server handles (e.g. [".ts", ".tsx"]). Defaults to a built-in table keyed by language. */
      extensions?: string[];
      /** Workspace root for this server — a filesystem path or file:// URI. */
      rootUri?: string;
      /** Workspace root as a plain filesystem path. */
      rootPath?: string;
      /** Extra environment variables for the server process. */
      env?: Record<string, string>;
      /** Initialization options passed in the LSP initialize request. */
      initializationOptions?: Record<string, unknown>;
      /** Milliseconds to wait for the initialize request before failing (default: no timeout). */
      startupTimeout?: number;
    };

/** The [lsp] settings section — configures LSP servers for the LSP tool. */
export interface LspSettings {
  /**
   * Language servers keyed by language name, e.g.
   * `{ servers: { typescript: ["typescript-language-server", ["--stdio"]] } }`.
   */
  servers?: Record<string, LspServerConfigEntry>;
  /** Optional workspace root (filesystem path) per language. */
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
}

// ─── Initialization ─────────────────────────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ─── Settings ───────────────────────────────────────────────────────────────

export function loadSettings(): PersistedSettings {
  try {
    if (!existsSync(SETTINGS_FILE)) return {};
    const raw = readFileSync(SETTINGS_FILE, "utf-8");
    const settings = JSON.parse(raw) as PersistedSettings;
    // Migrate to the latest schema (idempotent, never throws). Persist the
    // migrated shape directly (not via saveSettings, which would recurse).
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
      // best-effort — migrations never block settings load
    }
    return settings;
  } catch {
    return {};
  }
}

export function saveSettings(settings: PersistedSettings): void {
  ensureDataDir();
  // Merge with existing settings
  const existing = loadSettings();
  const merged = { ...existing, ...settings };
  writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), "utf-8");
}

// ─── Prompt history ─────────────────────────────────────────────────────────

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
    // best-effort
  }
}

/** Append an entry (dedup vs the last), persist, and return the resulting list. */
export function appendHistory(entry: string): string[] {
  const trimmed = entry.trim();
  if (!trimmed) return loadHistory();
  const list = loadHistory();
  if (list[list.length - 1] !== trimmed) list.push(trimmed);
  const capped = list.slice(-MAX_HISTORY);
  saveHistory(capped);
  return capped;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/** Generate a short hash for a session */
function generateSessionHash(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

/** Save a session to disk */
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

  // Update last session hash in settings
  saveSettings({ lastSessionHash: hash });

  return hash;
}

/** Update an existing session */
export function updateSession(hash: string, updates: Partial<SessionData>): void {
  const filePath = join(SESSIONS_DIR, `${hash}.json`);
  if (!existsSync(filePath)) return;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as SessionData;
    const updated = { ...data, ...updates, updatedAt: Date.now() };
    writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf-8");
  } catch {
    // Silently fail — sessions are best-effort
  }
}

/** Load a session by hash */
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

/** List all sessions, newest first */
export function listSessions(): SessionData[] {
  ensureDataDir();
  try {
    const files = readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse(); // newest first (hashes start with timestamp)

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

/** Delete old sessions, keeping only the N most recent */
export function pruneSessions(keepCount = 50): void {
  const sessions = listSessions();
  if (sessions.length <= keepCount) return;

  const toDelete = sessions.slice(keepCount);
  for (const session of toDelete) {
    try {
      unlinkSync(join(SESSIONS_DIR, `${session.hash}.json`));
    } catch {
      // Silently fail
    }
  }
}

/** Delete sessions older than `days` days (by updatedAt). */
export function pruneOldSessions(days = 30): number {
  const sessions = listSessions();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const session of sessions) {
    if (session.updatedAt < cutoff) {
      try {
        unlinkSync(join(SESSIONS_DIR, `${session.hash}.json`));
        removed++;
      } catch {
        // Silently fail
      }
    }
  }
  return removed;
}

/** Get the data directory path (for display) */
export function getDataDir(): string {
  return DATA_DIR;
}
