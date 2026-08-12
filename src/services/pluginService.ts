// Plugin Service — Manage local plugins and decentralized marketplaces
// Compatible with Claude Code's plugin manifest specifications.
//
// MARKETPLACE MODEL (ported from Claude Code's ecosystem — utils/plugins/*):
// A marketplace is now [name, source ('github'), repo ('owner/repo' OR
// 'owner/repo/path'), description?] instead of a bare URL list. Marketplaces
// are git repositories whose plugins live in directories:
//
//   <repo>/
//     .claude-plugin/marketplace.json      # marketplace index (name, owner, plugins[])
//     plugins/<name>/.claude-plugin/plugin.json
//     external_plugins/<name>/...          # in-repo plugin dirs
//
// fetchMarketplacePlugins() enumerates plugin dirs via the GitHub git-trees
// API and reads each .claude-plugin/plugin.json via raw.githubusercontent.com;
// installPlugin() clones (or tarball-downloads) the full plugin — commands/,
// agents/, skills/, .claude-plugin/ — not just a manifest.
//
// RETRO-COMPAT with the Claude Code plugin ecosystem: besides
// ~/.deepseek-code/plugins/<name>/manifest.json, the loader also discovers
// plugins installed by Claude Code at ~/.claude/plugins/cache/**/.claude-plugin/plugin.json
// and translates their layout (commands/, agents/, skills/ markdown files with
// frontmatter) into this app's plugin shape, so marketplace plugins work as-is.
// Installed plugins keep the claude-code layout (<plugin>/.claude-plugin/plugin.json)
// so both loaders agree.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  cpSync,
  statSync,
} from "fs";
import { join, basename, dirname, relative, sep } from "path";
import { homedir } from "os";

// ─── Paths ──────────────────────────────────────────────────────────────────
//
// DEEPSEEK_CODE_DATA_DIR overrides the data directory (like Claude Code's
// CLAUDE_CODE_PLUGIN_CACHE_DIR) — used by tests/probes to run against a
// temporary directory instead of the real ~/.deepseek-code.

const DATA_DIR = (() => {
  const override = process.env.DEEPSEEK_CODE_DATA_DIR;
  return override && override.trim() ? override.trim() : join(homedir(), ".deepseek-code");
})();
const PLUGINS_DIR = join(DATA_DIR, "plugins");
const MARKETPLACES_FILE = join(DATA_DIR, "marketplaces.json");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
/** Claude Code's plugin install location (marketplace cache). */
const CC_PLUGINS_DIR = process.env.DEEPSEEK_CODE_DATA_DIR
  ? join(DATA_DIR, "..", ".claude", "plugins")
  : join(homedir(), ".claude", "plugins");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PluginSkill {
  name: string;
  description: string;
  prompt: string;
  allowedTools?: string[];
}

export interface PluginCommand {
  /** Command name (markdown filename without extension). */
  name: string;
  description?: string;
  /** Body of the markdown file — sent to the model as the command. */
  prompt: string;
  argumentHint?: string;
}

export interface PluginAgent {
  name: string;
  description?: string;
  prompt: string;
  tools?: string[];
  model?: string;
}

export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  mcpServers?: Record<string, any>;
  skills?: PluginSkill[];
  /** Claude Code plugin commands/ directory — translated at load. */
  commands?: PluginCommand[];
  /** Claude Code plugin agents/ directory — translated at load. */
  agents?: PluginAgent[];
}

export interface InstalledPlugin {
  name: string;
  manifest: PluginManifest;
  enabled: boolean;
  /** Set when the plugin was discovered from Claude Code's plugin dir. */
  fromClaudeCode?: boolean;
}

/** A configured marketplace, persisted in ~/.deepseek-code/marketplaces.json.
 *  For source 'github', `repo` is 'owner/repo' or 'owner/repo/path' (a
 *  subdirectory of the repository that holds the marketplace). For the legacy
 *  source 'url', `repo` holds the marketplace manifest URL. */
export interface MarketplaceConfig {
  name: string;
  source: "github" | "url";
  repo: string;
  description?: string;
}

/** A plugin available from a marketplace (the Browse list in PluginPanel). */
export interface MarketplaceEntry {
  name: string;
  description: string;
  version: string;
  /** Repository to install from: 'owner/repo', 'owner/repo/path', or a git URL. */
  repository: string;
  /** Marketplace this entry came from. */
  marketplace?: string;
  /** GitHub owner of the marketplace repository. */
  owner?: string;
  /** Marketplace repository ('owner/repo'). */
  repo?: string;
  /** Subdirectory of the repository containing the plugin (git-subdir sources). */
  path?: string;
}

// ─── Default Config ─────────────────────────────────────────────────────────
//
// The official Anthropic marketplace (anthropics/claude-plugins-official) is
// registered by default alongside the existing deepseek-code marketplace
// (mhdimo/deepseek-code-plugins — ported from its old raw-URL form).

const OFFICIAL_MARKETPLACE_SOURCE = {
  source: "github",
  repo: "anthropics/claude-plugins-official",
} as const;

const DEFAULT_MARKETPLACES: MarketplaceConfig[] = [
  {
    name: "official",
    source: "github",
    repo: OFFICIAL_MARKETPLACE_SOURCE.repo,
    description: "Official Anthropic plugins marketplace",
  },
];

function ensureDirs(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true });
}

// ─── Local Plugin API ───────────────────────────────────────────────────────

/** Load all installed plugins: ours (~/.deepseek-code/plugins/) plus any
 *  Claude Code marketplace plugins (~/.claude/plugins/cache/…). Ours win on
 *  name collisions. Both legacy root manifest.json plugins and claude-code
 *  layout plugins (<plugin>/.claude-plugin/plugin.json) are translated. */
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
      const pluginDir = join(PLUGINS_DIR, name);
      // Legacy layout: manifest.json at the plugin root.
      const manifestPath = join(pluginDir, "manifest.json");
      if (existsSync(manifestPath)) {
        try {
          const raw = readFileSync(manifestPath, "utf-8");
          const manifest = JSON.parse(raw) as PluginManifest;
          const enabled = enabledMap[name] !== false; // defaults to true if not specified
          plugins.push({ name, manifest, enabled });
          continue;
        } catch {}
      }
      // Claude Code layout: .claude-plugin/plugin.json — translated by the
      // same helper that reads Claude Code's own plugin cache.
      const ccManifestDir = join(pluginDir, ".claude-plugin");
      if (existsSync(join(ccManifestDir, "plugin.json"))) {
        const translated = translateClaudeCodePluginDir(ccManifestDir);
        if (translated) {
          plugins.push({
            ...translated,
            enabled: enabledMap[translated.name] !== false,
            fromClaudeCode: undefined,
          });
        }
      }
    }
  } catch {}

  // Claude Code marketplace plugins (retro-compat)
  const seen = new Set(plugins.map((p) => p.name));
  for (const cc of loadClaudeCodePlugins()) {
    if (seen.has(cc.name)) continue;
    seen.add(cc.name);
    plugins.push(cc);
  }

  return plugins;
}

// ─── Claude Code plugin retro-compat ────────────────────────────────────────

/** Minimal frontmatter parser for claude-code command/agent/skill files:
 *  `key: value` lines between --- fences (rich YAML values pass through). */
function parseFrontmatter(
  body: string,
): { frontmatter: Record<string, string>; content: string } {
  const frontmatter: Record<string, string> = {};
  if (!body.startsWith("---")) return { frontmatter, content: body };
  const end = body.indexOf("\n---", 3);
  if (end === -1) return { frontmatter, content: body };
  const block = body.slice(3, end);
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontmatter, content: body.slice(end + 4).trim() };
}

function readMarkdownFrontmatter(
  file: string,
): { frontmatter: Record<string, string>; content: string } | null {
  try {
    if (!existsSync(file)) return null;
    return parseFrontmatter(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** Translate a claude-code-layout plugin dir — the directory containing
 *  `.claude-plugin/plugin.json` — into our InstalledPlugin shape. Reads the
 *  manifest plus commands/, agents/ and skills/ markdown files. Returns null
 *  when the dir has no readable plugin.json. */
function translateClaudeCodePluginDir(
  manifestDir: string,
  opts: { fromClaudeCode?: boolean } = {},
): InstalledPlugin | null {
  try {
    const rootDir = join(manifestDir, "..");
    const raw = readFileSync(join(manifestDir, "plugin.json"), "utf-8");
    const cc = JSON.parse(raw) as {
      name?: string;
      description?: string;
      version?: string;
      commands?: Array<string | { source: string; description?: string }>;
      agents?: Array<string | { source: string; description?: string }>;
      skills?: Array<string | { source: string; description?: string }>;
      mcpServers?: Record<string, unknown>;
    };
    const name = cc.name || basename(rootDir);
    if (!name) return null;

    // commands/ and agents/ standard dirs + explicitly listed files
    const commandFiles: Array<{ file: string; desc?: string }> = [];
    const agentFiles: Array<{ file: string; desc?: string }> = [];
    const skillDirs: Array<{ dir: string; desc?: string }> = [];
    const commandsDir = join(rootDir, "commands");
    if (existsSync(commandsDir)) {
      for (const f of readdirSync(commandsDir)) {
        if (f.endsWith(".md")) commandFiles.push({ file: join(commandsDir, f) });
      }
    }
    const agentsDir = join(rootDir, "agents");
    if (existsSync(agentsDir)) {
      for (const f of readdirSync(agentsDir)) {
        if (f.endsWith(".md")) agentFiles.push({ file: join(agentsDir, f) });
      }
    }
    const skillsDir = join(rootDir, "skills");
    if (existsSync(skillsDir)) {
      for (const d of readdirSync(skillsDir)) {
        const sdir = join(skillsDir, d);
        if (existsSync(join(sdir, "SKILL.md"))) skillDirs.push({ dir: sdir });
      }
    }
    for (const c of cc.commands ?? []) {
      if (typeof c === "string") commandFiles.push({ file: join(rootDir, c) });
      else commandFiles.push({ file: join(rootDir, c.source), desc: c.description });
    }
    for (const a of cc.agents ?? []) {
      if (typeof a === "string") agentFiles.push({ file: join(rootDir, a) });
      else agentFiles.push({ file: join(rootDir, a.source), desc: a.description });
    }
    for (const s of cc.skills ?? []) {
      if (typeof s === "string") skillDirs.push({ dir: join(rootDir, s) });
      else skillDirs.push({ dir: join(rootDir, s.source), desc: s.description });
    }

    const commands: PluginCommand[] = [];
    for (const { file, desc } of commandFiles) {
      const parsed = readMarkdownFrontmatter(file);
      if (!parsed) continue;
      commands.push({
        name: basename(file, ".md"),
        description: desc ?? parsed.frontmatter["description"],
        prompt: parsed.content,
        argumentHint: parsed.frontmatter["argument-hint"],
      });
    }

    const agents: PluginAgent[] = [];
    for (const { file, desc } of agentFiles) {
      const parsed = readMarkdownFrontmatter(file);
      if (!parsed) continue;
      agents.push({
        name: parsed.frontmatter["name"] || basename(file, ".md"),
        description: desc ?? parsed.frontmatter["description"],
        prompt: parsed.content,
        tools: parsed.frontmatter["tools"]?.split(",").map((t) => t.trim()),
        model: parsed.frontmatter["model"],
      });
    }

    const skills: PluginSkill[] = [];
    for (const { dir, desc } of skillDirs) {
      const skillFile = join(dir, "SKILL.md");
      const parsed = readMarkdownFrontmatter(skillFile);
      if (!parsed) continue;
      skills.push({
        name: parsed.frontmatter["name"] || basename(dir),
        description: desc ?? parsed.frontmatter["description"] ?? "",
        prompt: parsed.content,
      });
    }

    return {
      name,
      manifest: {
        name,
        description: cc.description ?? "",
        version: cc.version ?? "0.0.0",
        mcpServers: cc.mcpServers,
        skills: skills.length > 0 ? skills : undefined,
        commands: commands.length > 0 ? commands : undefined,
        agents: agents.length > 0 ? agents : undefined,
      },
      enabled: true,
      fromClaudeCode: opts.fromClaudeCode,
    };
  } catch {
    // skip unreadable plugin entries
    return null;
  }
}

/** Walk ~/.claude/plugins/ for `.claude-plugin/plugin.json` files (cache
 *  layout: plugins/cache/<marketplace>/<plugin>/<version>/ — scan up to 5
 *  levels deep) and translate each into our InstalledPlugin shape. */
function loadClaudeCodePlugins(): InstalledPlugin[] {
  const found: InstalledPlugin[] = [];
  if (!existsSync(CC_PLUGINS_DIR)) return found;

  const walk = (dir: string, depth: number): string[] => {
    if (depth > 5) return [];
    try {
      const out: string[] = [];
      for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const sub = join(dir, dirent.name);
        if (dirent.name === ".claude-plugin" && existsSync(join(sub, "plugin.json"))) {
          out.push(sub);
        } else {
          out.push(...walk(sub, depth + 1));
        }
      }
      return out;
    } catch {
      return [];
    }
  };

  for (const manifestDir of walk(CC_PLUGINS_DIR, 0)) {
    const translated = translateClaudeCodePluginDir(manifestDir, {
      fromClaudeCode: true,
    });
    if (translated) found.push(translated);
  }

  return found;
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

/** Extract 'owner/repo' from a github URL (https, raw.githubusercontent,
 *  git@ssh) or pass through an existing 'owner/repo' shorthand. A shorthand
 *  with a deeper path ('owner/repo/path') is left untouched (returns null —
 *  callers keep it whole). Returns null when the input is not github-shaped. */
function repoFromGithubUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, "");
  let m = trimmed.match(
    /^(?:https?:\/\/)?(?:raw\.githubusercontent\.com|github\.com)\/([^/]+\/[^/]+?)(?:\.git)?(?:\/|$)/,
  );
  if (m?.[1]) return m[1];
  m = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (m?.[1]) return m[1];
  m = trimmed.match(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
  if (m) return m[0];
  return null;
}

/** Translate a legacy marketplaces.json entry ({ name, url }) into the new
 *  marketplace shape. GitHub URLs become source 'github' with an
 *  'owner/repo' repo; any other URL keeps working as source 'url'. */
function migrateMarketplaceEntry(
  entry: Record<string, unknown>,
): MarketplaceConfig | null {
  if (typeof entry !== "object" || entry === null) return null;
  const name = typeof entry.name === "string" ? entry.name : "";
  if (!name) return null;
  if (typeof entry.source === "string" && typeof entry.repo === "string") {
    // Already the new shape.
    return {
      name,
      source: entry.source === "url" ? "url" : "github",
      repo: entry.repo,
      description: typeof entry.description === "string" ? entry.description : undefined,
    };
  }
  const url = typeof entry.url === "string" ? entry.url : "";
  if (!url) return null;
  const gh = repoFromGithubUrl(url);
  return {
    name,
    source: gh ? "github" : "url",
    repo: gh ?? url,
    description: typeof entry.description === "string" ? entry.description : undefined,
  };
}

/** Load configured marketplaces (new shape: name/source/repo). Legacy
 *  entries with `url` fields are migrated in place and persisted back. */
export function loadMarketplaces(): MarketplaceConfig[] {
  ensureDirs();
  try {
    if (existsSync(MARKETPLACES_FILE)) {
      const raw = readFileSync(MARKETPLACES_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const migrated: MarketplaceConfig[] = [];
        let changed = false;
        for (const entry of parsed) {
          const m = migrateMarketplaceEntry(entry);
          if (m) {
            migrated.push(m);
            if (!(entry.source === m.source && entry.repo === m.repo)) changed = true;
          } else {
            changed = true;
          }
        }
        // Persist the migration so the file converges on the new shape.
        if (changed) {
          try {
            writeFileSync(MARKETPLACES_FILE, JSON.stringify(migrated, null, 2), "utf-8");
          } catch {}
        }
        return migrated;
      }
    }
  } catch {}

  // Write defaults if not exist
  try {
    if (!existsSync(MARKETPLACES_FILE)) {
      writeFileSync(MARKETPLACES_FILE, JSON.stringify(DEFAULT_MARKETPLACES, null, 2), "utf-8");
    }
  } catch {}
  return DEFAULT_MARKETPLACES;
}

/** Add a marketplace: name + repository ('owner/repo', 'owner/repo/path', a
 *  github URL, or a full marketplace manifest URL). Replaces an existing
 *  marketplace with the same name. */
export function addMarketplace(name: string, repo: string): void {
  ensureDirs();
  const cleanName = name.trim();
  const rawRepo = repo.trim();
  if (!cleanName || !rawRepo) return;
  const markets = loadMarketplaces();

  let source: "github" | "url" = "github";
  let cleanRepo = rawRepo.replace(/\/+$/, "");
  const gh = repoFromGithubUrl(cleanRepo);
  if (gh) {
    cleanRepo = gh;
  } else if (/^https?:\/\//.test(cleanRepo)) {
    source = "url";
  }

  const existing = markets.find((m) => m.name === cleanName);
  const entry: MarketplaceConfig = {
    name: cleanName,
    source,
    repo: cleanRepo,
    description: existing?.description,
  };
  if (existing) {
    existing.source = entry.source;
    existing.repo = entry.repo;
    if (entry.description) existing.description = entry.description;
  } else {
    markets.push(entry);
  }
  try {
    writeFileSync(MARKETPLACES_FILE, JSON.stringify(markets, null, 2), "utf-8");
  } catch {}
}

/** Remove a marketplace by name. No-op when it is not configured. */
export function removeMarketplace(name: string): void {
  ensureDirs();
  try {
    if (!existsSync(MARKETPLACES_FILE)) return;
    const parsed = JSON.parse(readFileSync(MARKETPLACES_FILE, "utf-8"));
    if (!Array.isArray(parsed)) return;
    const next = parsed.filter(
      (m: Record<string, unknown>) => m && typeof m.name === "string" && m.name !== name,
    );
    writeFileSync(MARKETPLACES_FILE, JSON.stringify(next, null, 2), "utf-8");
  } catch {}
}

/** Split a 'owner/repo/path' reference into the repo part and the optional
 *  in-repo path. */
function splitRepoPath(repo: string): { repoPath: string; subdir: string } {
  const idx = repo.indexOf("/");
  if (idx === -1) return { repoPath: repo, subdir: "" };
  const rest = repo.slice(idx + 1);
  const idx2 = rest.indexOf("/");
  if (idx2 === -1) return { repoPath: repo, subdir: "" };
  return {
    repoPath: `${repo.slice(0, idx)}/${rest.slice(0, idx2)}`,
    subdir: rest.slice(idx2 + 1),
  };
}

const FETCH_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

/** Fetch all plugins from a github marketplace: read the marketplace index
 *  (.claude-plugin/marketplace.json, falling back to a root marketplace.json),
 *  enumerate in-repo plugin dirs via the git-trees API, and merge each
 *  .claude-plugin/plugin.json (name/description/version) with its
 *  marketplace.json entry (source → repository). Failures are swallowed per
 *  marketplace. */
async function fetchGithubMarketplacePlugins(m: MarketplaceConfig): Promise<MarketplaceEntry[]> {
  const { repoPath, subdir } = splitRepoPath(m.repo);
  const parts = repoPath.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return [];
  const rel = (p: string): string => (subdir ? `${subdir}/${p}` : p);

  // 1. Marketplace index — the authoritative plugin list.
  let manifestData: any = null;
  for (const manifestRel of [rel(".claude-plugin/marketplace.json"), rel("marketplace.json")]) {
    const res = await fetchWithTimeout(
      `https://raw.githubusercontent.com/${owner}/${repo}/main/${manifestRel}`,
    );
    if (res && res.ok) {
      try {
        manifestData = await res.json();
      } catch {}
      break;
    }
  }

  // 2. Enumerate plugin dirs: every `.claude-plugin/plugin.json` blob.
  let treePaths: string[] = [];
  try {
    const treeRes = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`,
    );
    if (treeRes && treeRes.ok) {
      const tree = (await treeRes.json()) as {
        tree?: Array<{ type?: string; path?: string }>;
      };
      treePaths = (tree.tree ?? [])
        .filter((t) => t.type === "blob" && t.path?.endsWith(".claude-plugin/plugin.json"))
        .map((t) => t.path as string)
        .filter((p) => (subdir ? p.startsWith(`${subdir}/`) : true));
    }
  } catch {}

  // Legacy array-format marketplace.json (old deepseek-code layout): entries
  // are MarketplaceEntry-shaped already.
  if (Array.isArray(manifestData)) {
    return (manifestData as Array<Record<string, unknown>>)
      .filter((p) => p && typeof p.name === "string")
      .map((p) => ({
        name: p.name as string,
        description: typeof p.description === "string" ? p.description : "",
        version: typeof p.version === "string" ? p.version : "0.0.0",
        repository: typeof p.repository === "string" ? p.repository : `${owner}/${repo}`,
        marketplace: m.name,
        owner,
        repo: `${owner}/${repo}`,
      }));
  }

  const manifestPlugins = Array.isArray(manifestData?.plugins) ? manifestData.plugins : [];
  const byName = new Map<string, Record<string, unknown>>();
  for (const p of manifestPlugins) {
    if (p && typeof p.name === "string") byName.set(p.name, p);
  }

  // 3. Fetch each in-repo plugin.json (bounded parallelism).
  const pluginJsonByDir = new Map<string, Record<string, unknown>>();
  const CHUNK = 10;
  for (let i = 0; i < treePaths.length; i += CHUNK) {
    const batch = treePaths.slice(i, i + CHUNK);
    const results = await Promise.all(
      batch.map(async (path) => {
        const res = await fetchWithTimeout(
          `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`,
        );
        if (!res || !res.ok) return null;
        try {
          const json = (await res.json()) as Record<string, unknown>;
          // Tree path is <plugin>/.claude-plugin/plugin.json — the plugin
          // root dir is two levels up.
          return typeof json.name === "string"
            ? { dir: dirname(dirname(path)), json }
            : null;
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) pluginJsonByDir.set(r.dir, r.json);
    }
  }

  /** Find the marketplace entry whose local source ('./plugins/x') matches a
   *  plugin dir, falling back to an entry named after the dir. */
  const entryForDir = (dir: string): Record<string, unknown> | null => {
    for (const e of byName.values()) {
      const s = e.source;
      if (typeof s === "string" && s.startsWith("./") && s.slice(2) === dir) return e;
    }
    return byName.get(basename(dir)) ?? null;
  };

  /** Repository reference for an entry: in-repo local sources become
   *  'owner/repo/path' (installPlugin clones the repo and copies the dir);
   *  remote sources keep their git URL / repo shorthand. */
  const repositoryFor = (
    entry: Record<string, unknown> | null,
    dir: string | null,
  ): { repository: string; path?: string } => {
    const source = entry?.source;
    if (typeof source === "string" && source.startsWith("./")) {
      return { repository: `${owner}/${repo}/${source.slice(2)}` };
    }
    if (source && typeof source === "object") {
      const s = source as Record<string, unknown>;
      if (typeof s.url === "string") return { repository: s.url, path: typeof s.path === "string" ? s.path : undefined };
      if (typeof s.repo === "string") return { repository: s.repo };
    }
    if (dir) return { repository: `${owner}/${repo}/${dir}` };
    return { repository: `${owner}/${repo}` };
  };

  const entries: MarketplaceEntry[] = [];
  const seen = new Set<string>();

  // 4a. In-repo plugins (have a plugin.json in the marketplace repo).
  for (const [dir, pj] of pluginJsonByDir) {
    const entry = entryForDir(dir);
    const name = typeof pj.name === "string" ? pj.name : entry?.name;
    if (!name || typeof name !== "string" || seen.has(name)) continue;
    seen.add(name);
    const { repository, path } = repositoryFor(entry, dir);
    entries.push({
      name,
      description:
        (typeof entry?.description === "string" ? entry.description : "") ||
        (typeof pj.description === "string" ? pj.description : ""),
      version: typeof pj.version === "string" ? pj.version : "0.0.0",
      repository,
      path,
      marketplace: m.name,
      owner,
      repo: `${owner}/${repo}`,
    });
  }

  // 4b. Remaining marketplace.json entries (external plugins) — no in-repo
  // plugin.json, so name/description come from the index alone.
  for (const p of manifestPlugins) {
    const pname = p.name;
    if (!pname || seen.has(pname)) continue;
    seen.add(pname);
    const { repository, path } = repositoryFor(p, null);
    entries.push({
      name: pname,
      description: typeof p.description === "string" ? p.description : "",
      version: typeof p.version === "string" ? p.version : "0.0.0",
      repository,
      path,
      marketplace: m.name,
      owner,
      repo: `${owner}/${repo}`,
    });
  }

  return entries;
}

/** Legacy url-source marketplace: fetch the manifest JSON directly. Accepts
 *  both the old array format and the claude-code object format. */
async function fetchUrlMarketplacePlugins(m: MarketplaceConfig): Promise<MarketplaceEntry[]> {
  const res = await fetchWithTimeout(m.repo);
  if (!res || !res.ok) return [];
  try {
    const data = (await res.json()) as
      | Array<Record<string, unknown>>
      | { plugins?: Array<Record<string, unknown>> };
    const list = Array.isArray(data) ? data : (data.plugins ?? []);
    return (list as Array<Record<string, unknown>>)
      .filter((p) => p && typeof p.name === "string")
      .map((p) => ({
        name: p.name as string,
        description: typeof p.description === "string" ? p.description : "",
        version: typeof p.version === "string" ? p.version : "0.0.0",
        repository: typeof p.repository === "string" ? p.repository : m.repo,
        marketplace: m.name,
        repo: m.repo,
      }));
  } catch {
    return [];
  }
}

/** Fetch list of plugins available in all marketplaces. Individual
 *  marketplace failures are swallowed (returns [] for that marketplace) so a
 *  dead or offline source never breaks browsing. */
export async function fetchMarketplacePlugins(): Promise<MarketplaceEntry[]> {
  const marketplaces = loadMarketplaces();
  const allEntries: MarketplaceEntry[] = [];
  const seen = new Set<string>();

  for (const m of marketplaces) {
    try {
      const entries =
        m.source === "github"
          ? await fetchGithubMarketplacePlugins(m)
          : await fetchUrlMarketplacePlugins(m);
      for (const e of entries) {
        if (!e.name || seen.has(e.name)) continue;
        seen.add(e.name);
        allEntries.push(e);
      }
    } catch {
      // per-marketplace failures never break the aggregate
    }
  }

  return allEntries;
}

// ─── Plugin installation ────────────────────────────────────────────────────

/** Parse an install repository reference into a clone URL plus the optional
 *  subdirectory of the repository that holds the plugin. Accepts github
 *  URLs, git@ssh URLs, other git URLs, and the 'owner/repo[/path]' form. */
function parsePluginRepository(
  repo: string,
): { cloneUrl: string; subdir?: string } | null {
  const trimmed = repo.trim().replace(/\/+$/, "");
  if (!trimmed) return null;

  let m = trimmed.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?(?:\/(.*))?$/);
  if (m?.[1]) return { cloneUrl: m[1], subdir: m[2] };
  m = trimmed.match(/^(git@github\.com:[^/]+\/[^/]+?)(?:\.git)?(?:\/(.*))?$/);
  if (m?.[1]) return { cloneUrl: m[1], subdir: m[2] };
  if (/^(https?:\/\/|ssh:\/\/|git@)/.test(trimmed)) {
    // Any other git URL — clone as-is (tarball fallback is github-only).
    return { cloneUrl: trimmed };
  }
  m = trimmed.match(/^([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)(?:\/(.*))?$/);
  if (m?.[1]) return { cloneUrl: `https://github.com/${m[1]}.git`, subdir: m[2] };
  return null;
}

/** codeload tarball URL for a github clone URL (used when git is missing). */
function tarballUrlFor(cloneUrl: string): string | null {
  const m = cloneUrl.match(
    /^(?:https?:\/\/|git@)github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
  );
  if (!m?.[1]) return null;
  return `https://codeload.github.com/${m[1]}/tar.gz/refs/heads/main`;
}

/** Clone a repository into target (git clone --depth 1 when git is
 *  available, else download + extract the codeload tarball with tar -xzf). */
async function acquireRepository(cloneUrl: string, target: string): Promise<boolean> {
  const gitCheck = Bun.spawnSync(["git", "--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (gitCheck.exitCode === 0) {
    const result = Bun.spawnSync(["git", "clone", "--depth", "1", cloneUrl, target], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.exitCode === 0) return true;
    // git failed (network/auth) — fall through to the tarball path.
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {}
  }

  const tarballUrl = tarballUrlFor(cloneUrl);
  if (!tarballUrl) return false;
  try {
    const res = await fetch(tarballUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true });
    const tmpTar = join(parent, "bundle.tar.gz");
    writeFileSync(tmpTar, buf);
    const extract = Bun.spawnSync(["tar", "-xzf", tmpTar, "-C", parent], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (extract.exitCode !== 0) return false;
    // The tarball extracts as <repo>-<branch>/ — move the single top-level
    // directory into place.
    const entries = readdirSync(parent).filter((e) => e !== "bundle.tar.gz");
    if (entries.length !== 1) return false;
    const extracted = entries[0];
    if (!extracted) return false;
    const extractedPath = join(parent, extracted);
    if (!existsSync(extractedPath) || !statSync(extractedPath).isDirectory()) return false;
    rmSync(tmpTar, { force: true });
    rmSync(target, { recursive: true, force: true });
    cpSync(extractedPath, target, { recursive: true });
    rmSync(extractedPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Locate the plugin's directory inside a cloned marketplace repo. */
function locatePluginDir(
  repoRoot: string,
  subdir: string | undefined,
  name: string,
): string | null {
  const candidates: string[] = [];
  if (subdir) candidates.push(subdir);
  candidates.push(`plugins/${name}`, `external_plugins/${name}`, name);
  for (const c of candidates) {
    const p = join(repoRoot, c);
    const rel = relative(repoRoot, p);
    if (rel === ".." || rel.startsWith(`..${sep}`)) continue; // escape guard
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }
  return null;
}

/** A valid plugin dir carries either the claude-code layout
 *  (.claude-plugin/plugin.json) or the legacy root manifest.json. */
function isPluginDir(dir: string): boolean {
  return (
    existsSync(join(dir, ".claude-plugin", "plugin.json")) ||
    existsSync(join(dir, "manifest.json"))
  );
}

/** Read the canonical plugin name from its manifest, if present. */
function readPluginName(dir: string): string | null {
  for (const p of [join(dir, ".claude-plugin", "plugin.json"), join(dir, "manifest.json")]) {
    try {
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, "utf-8"));
        if (typeof j.name === "string" && j.name) return j.name;
      }
    } catch {}
  }
  return null;
}

/** Legacy install path: fetch a single manifest.json from a URL (the old
 *  URL-list marketplace model). Kept for backward compatibility with
 *  previously-installed plugins and persisted entries. */
async function installPluginFromManifestUrl(name: string, url: string): Promise<boolean> {
  let cleanUrl = url.trim().replace(/\.git$/, "");
  if (cleanUrl.startsWith("https://github.com/")) {
    cleanUrl = cleanUrl.replace("https://github.com/", "https://raw.githubusercontent.com/");
    // Assume default branch is main
    cleanUrl = `${cleanUrl}/main/manifest.json`;
  } else if (!cleanUrl.endsWith("manifest.json")) {
    cleanUrl = `${cleanUrl}/manifest.json`;
  }

  try {
    const res = await fetchWithTimeout(cleanUrl);
    if (!res || !res.ok) return false;
    const manifest = (await res.json()) as PluginManifest;

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

/** Install a plugin from a marketplace repository reference. Clones or
 *  downloads the FULL plugin (commands/, agents/, skills/, .claude-plugin/)
 *  into ~/.deepseek-code/plugins/<name>/ — not just a manifest. The plugin
 *  keeps the claude-code layout (<plugin>/.claude-plugin/plugin.json) so both
 *  loaders (ours and Claude Code's) agree.
 *
 *  `repository` may be 'owner/repo', 'owner/repo/path' (the subdirectory of
 *  the repo holding the plugin), or a git URL. Legacy raw-manifest URLs still
 *  install via the old manifest-fetch path. */
export async function installPlugin(name: string, repository: string): Promise<boolean> {
  ensureDirs();
  const repo = (repository ?? "").trim();
  if (!repo) return false;

  // Legacy: a direct manifest URL (old URL-list marketplace model).
  if (
    (repo.startsWith("https://raw.githubusercontent.com/") &&
      (repo.endsWith("manifest.json") || repo.endsWith("marketplace.json"))) ||
    (repo.endsWith("manifest.json") && !/^[a-zA-Z0-9_.-]+\//.test(repo))
  ) {
    return installPluginFromManifestUrl(name, repo);
  }

  const parsed = parsePluginRepository(repo);
  if (!parsed) return false;
  const { cloneUrl, subdir } = parsed;
  // A subdir pointing at the .claude-plugin dir itself means the plugin root
  // is its parent (legacy entries may carry the suffix).
  const pluginSubdir =
    subdir && subdir.endsWith("/.claude-plugin") ? subdir.slice(0, -"/.claude-plugin".length) : subdir;

  const tmpRoot = join(DATA_DIR, `.plugin-install-${process.pid}-${Date.now()}`);
  const tmpRepo = join(tmpRoot, "repo");
  try {
    mkdirSync(tmpRoot, { recursive: true });
    if (!(await acquireRepository(cloneUrl, tmpRepo))) return false;

    // The repo root itself can be the plugin (single-plugin repos).
    const pluginDir =
      locatePluginDir(tmpRepo, pluginSubdir, name) ??
      (isPluginDir(tmpRepo) ? tmpRepo : null);
    if (!pluginDir || !isPluginDir(pluginDir)) return false;

    const pluginName = readPluginName(pluginDir) ?? name;
    const destDir = join(PLUGINS_DIR, pluginName);
    if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
    mkdirSync(PLUGINS_DIR, { recursive: true });
    cpSync(pluginDir, destDir, { recursive: true });
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}
