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

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PersistedSettings {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  provider?: string;
  defaultAgent?: string;
  thinkingMode?: string;
  /** The hash of the last active session (for resume) */
  lastSessionHash?: string;
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
    return JSON.parse(raw) as PersistedSettings;
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

/** Get the data directory path (for display) */
export function getDataDir(): string {
  return DATA_DIR;
}
