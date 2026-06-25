import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DATA_DIR = join(homedir(), ".deepseek-code");
const STATS_FILE = join(DATA_DIR, "stats.json");

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SessionRecord {
  id: string;
  name: string;
  cwd: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  apiDurationMs: number;
  wallDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost: number;
}

export interface GlobalStats {
  sessions: SessionRecord[];
  dailyUsage: Record<string, number>; // "YYYY-MM-DD" -> tokens count
}

const DEFAULT_STATS: GlobalStats = {
  sessions: [],
  dailyUsage: {},
};

function ensureDir(): void {
  const fs = require("fs");
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadGlobalStats(): GlobalStats {
  try {
    if (!existsSync(STATS_FILE)) return DEFAULT_STATS;
    const raw = readFileSync(STATS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as GlobalStats;
    // Ensure structure is correct
    if (!parsed.sessions) parsed.sessions = [];
    if (!parsed.dailyUsage) parsed.dailyUsage = {};
    return parsed;
  } catch {
    return DEFAULT_STATS;
  }
}

export function saveGlobalStats(stats: GlobalStats): void {
  try {
    ensureDir();
    writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), "utf-8");
  } catch {
    // Best-effort
  }
}

/** Record or update a session's stats globally */
export function recordSessionStats(record: SessionRecord): void {
  const stats = loadGlobalStats();
  const index = stats.sessions.findIndex((s) => s.id === record.id);
  if (index >= 0) {
    stats.sessions[index] = record;
  } else {
    stats.sessions.push(record);
  }

  // Update dailyUsage for target date
  const dateStr = new Date(record.updatedAt).toISOString().split("T")[0]!;
  const currentTokens = record.tokens.input + record.tokens.output;
  // Subtract previous values of this session if we are updating
  let prevTokens = 0;
  if (index >= 0) {
    const prev = stats.sessions[index];
    if (prev) {
      prevTokens = prev.tokens.input + prev.tokens.output;
    }
  }
  const diff = currentTokens - prevTokens;
  if (diff > 0) {
    stats.dailyUsage[dateStr] = (stats.dailyUsage[dateStr] || 0) + diff;
  }

  saveGlobalStats(stats);
}
