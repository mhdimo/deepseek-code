// Plugin Service — Manage local plugins and decentralized marketplaces
// Compatible with Claude Code's plugin manifest specifications.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Paths ──────────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), ".deepseek-code");
const PLUGINS_DIR = join(DATA_DIR, "plugins");
const MARKETPLACES_FILE = join(DATA_DIR, "marketplaces.json");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PluginSkill {
  name: string;
  description: string;
  prompt: string;
  allowedTools?: string[];
}

export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  mcpServers?: Record<string, any>;
  skills?: PluginSkill[];
}

export interface InstalledPlugin {
  name: string;
  manifest: PluginManifest;
  enabled: boolean;
}

export interface MarketplaceEntry {
  name: string;
  description: string;
  version: string;
  repository: string;
}

// ─── Default Config ─────────────────────────────────────────────────────────

const DEFAULT_MARKETPLACES = [
  {
    name: "official",
    url: "https://raw.githubusercontent.com/mhdimo/deepseek-code-plugins/main/marketplace.json"
  }
];

function ensureDirs(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true });
}

// ─── Local Plugin API ───────────────────────────────────────────────────────

/** Load all installed plugins from ~/.deepseek-code/plugins/ */
export function loadInstalledPlugins(): InstalledPlugin[] {
  ensureDirs();
  const plugins: InstalledPlugin[] = [];

  // Load user enabled/disabled preferences from settings.json
  let enabledMap: Record<string, boolean> = {};
  try {
    if (existsSync(SETTINGS_FILE)) {
      const raw = readFileSync(SETTINGS_FILE, "utf-8");
      const settings = JSON.parse(raw);
      enabledMap = settings.enabledPlugins || {};
    }
  } catch {}

  try {
    const dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    for (const name of dirs) {
      const manifestPath = join(PLUGINS_DIR, name, "manifest.json");
      if (existsSync(manifestPath)) {
        try {
          const raw = readFileSync(manifestPath, "utf-8");
          const manifest = JSON.parse(raw) as PluginManifest;
          const enabled = enabledMap[name] !== false; // defaults to true if not specified
          plugins.push({ name, manifest, enabled });
        } catch {}
      }
    }
  } catch {}

  return plugins;
}

/** Enable or disable an installed plugin */
export function togglePlugin(name: string, enabled: boolean): void {
  ensureDirs();
  try {
    let settings: any = {};
    if (existsSync(SETTINGS_FILE)) {
      settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    }
    if (!settings.enabledPlugins) settings.enabledPlugins = {};
    settings.enabledPlugins[name] = enabled;
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
  } catch {}
}

/** Uninstall an installed plugin */
export function uninstallPlugin(name: string): void {
  ensureDirs();
  const dirPath = join(PLUGINS_DIR, name);
  if (existsSync(dirPath)) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
    } catch {}
  }
}

// ─── Marketplace API ────────────────────────────────────────────────────────

/** Load configured marketplaces */
export function loadMarketplaces(): Array<{ name: string; url: string }> {
  ensureDirs();
  try {
    if (existsSync(MARKETPLACES_FILE)) {
      const raw = readFileSync(MARKETPLACES_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch {}

  // Write defaults if not exist
  try {
    writeFileSync(MARKETPLACES_FILE, JSON.stringify(DEFAULT_MARKETPLACES, null, 2), "utf-8");
  } catch {}
  return DEFAULT_MARKETPLACES;
}

/** Add a new marketplace URL */
export function addMarketplace(name: string, url: string): void {
  ensureDirs();
  const markets = loadMarketplaces();
  markets.push({ name, url });
  try {
    writeFileSync(MARKETPLACES_FILE, JSON.stringify(markets, null, 2), "utf-8");
  } catch {}
}

/** Fetch list of plugins available in all marketplaces */
export async function fetchMarketplacePlugins(): Promise<MarketplaceEntry[]> {
  const marketplaces = loadMarketplaces();
  const allEntries: MarketplaceEntry[] = [];

  for (const m of marketplaces) {
    try {
      const res = await fetch(m.url);
      if (res.ok) {
        const data = await res.json() as MarketplaceEntry[];
        allEntries.push(...data);
      }
    } catch {}
  }

  return allEntries;
}

/** Install a plugin from a marketplace repository URL */
export async function installPlugin(name: string, repository: string): Promise<boolean> {
  ensureDirs();
  // Resolve raw.githubusercontent URL:
  // e.g. https://github.com/owner/repo -> https://raw.githubusercontent.com/owner/repo/main/manifest.json
  let cleanUrl = repository.trim().replace(/\.git$/, "");
  if (cleanUrl.startsWith("https://github.com/")) {
    cleanUrl = cleanUrl.replace("https://github.com/", "https://raw.githubusercontent.com/");
    // Assume default branch is main
    cleanUrl = `${cleanUrl}/main/manifest.json`;
  } else if (!cleanUrl.endsWith("manifest.json")) {
    cleanUrl = `${cleanUrl}/manifest.json`;
  }

  try {
    const res = await fetch(cleanUrl);
    if (!res.ok) return false;
    const manifest = await res.json() as PluginManifest;

    // Verify manifest name matches or assign it
    const pluginName = manifest.name || name;
    const destDir = join(PLUGINS_DIR, pluginName);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

    writeFileSync(join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}
