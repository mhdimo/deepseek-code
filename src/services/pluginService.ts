

























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







const DATA_DIR = (() => {
  const override = process.env.DEEPSEEK_CODE_DATA_DIR;
  return override && override.trim() ? override.trim() : join(homedir(), ".deepseek-code");
})();
const PLUGINS_DIR = join(DATA_DIR, "plugins");
const MARKETPLACES_FILE = join(DATA_DIR, "marketplaces.json");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

const CC_PLUGINS_DIR = process.env.DEEPSEEK_CODE_DATA_DIR
  ? join(DATA_DIR, "..", ".claude", "plugins")
  : join(homedir(), ".claude", "plugins");



export interface PluginSkill {
  name: string;
  description: string;
  prompt: string;
  allowedTools?: string[];
}

export interface PluginCommand {
  
  name: string;
  description?: string;
  
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
  
  commands?: PluginCommand[];
  
  agents?: PluginAgent[];
}

export interface InstalledPlugin {
  name: string;
  manifest: PluginManifest;
  enabled: boolean;
  
  fromClaudeCode?: boolean;
}


export interface MarketplaceConfig {
  name: string;
  source: "github" | "url";
  repo: string;
  description?: string;
}


export interface MarketplaceEntry {
  name: string;
  description: string;
  version: string;
  
  repository: string;
  
  marketplace?: string;
  
  owner?: string;
  
  repo?: string;
  
  path?: string;
}







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




export function loadInstalledPlugins(): InstalledPlugin[] {
  ensureDirs();
  const plugins: InstalledPlugin[] = [];

  
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
      
      const manifestPath = join(pluginDir, "manifest.json");
      if (existsSync(manifestPath)) {
        try {
          const raw = readFileSync(manifestPath, "utf-8");
          const manifest = JSON.parse(raw) as PluginManifest;
          const enabled = enabledMap[name] !== false; 
          plugins.push({ name, manifest, enabled });
          continue;
        } catch {}
      }
      
      
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

  
  const seen = new Set(plugins.map((p) => p.name));
  for (const cc of loadClaudeCodePlugins()) {
    if (seen.has(cc.name)) continue;
    seen.add(cc.name);
    plugins.push(cc);
  }

  return plugins;
}




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
    
    return null;
  }
}


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


export function uninstallPlugin(name: string): void {
  ensureDirs();
  const dirPath = join(PLUGINS_DIR, name);
  if (existsSync(dirPath)) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
    } catch {}
  }
}




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


function migrateMarketplaceEntry(
  entry: Record<string, unknown>,
): MarketplaceConfig | null {
  if (typeof entry !== "object" || entry === null) return null;
  const name = typeof entry.name === "string" ? entry.name : "";
  if (!name) return null;
  if (typeof entry.source === "string" && typeof entry.repo === "string") {
    
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
        
        if (changed) {
          try {
            writeFileSync(MARKETPLACES_FILE, JSON.stringify(migrated, null, 2), "utf-8");
          } catch {}
        }
        return migrated;
      }
    }
  } catch {}

  
  try {
    if (!existsSync(MARKETPLACES_FILE)) {
      writeFileSync(MARKETPLACES_FILE, JSON.stringify(DEFAULT_MARKETPLACES, null, 2), "utf-8");
    }
  } catch {}
  return DEFAULT_MARKETPLACES;
}


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


async function fetchGithubMarketplacePlugins(m: MarketplaceConfig): Promise<MarketplaceEntry[]> {
  const { repoPath, subdir } = splitRepoPath(m.repo);
  const parts = repoPath.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return [];
  const rel = (p: string): string => (subdir ? `${subdir}/${p}` : p);

  
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

  
  const entryForDir = (dir: string): Record<string, unknown> | null => {
    for (const e of byName.values()) {
      const s = e.source;
      if (typeof s === "string" && s.startsWith("./") && s.slice(2) === dir) return e;
    }
    return byName.get(basename(dir)) ?? null;
  };

  
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
      
    }
  }

  return allEntries;
}




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
    
    return { cloneUrl: trimmed };
  }
  m = trimmed.match(/^([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)(?:\/(.*))?$/);
  if (m?.[1]) return { cloneUrl: `https://github.com/${m[1]}.git`, subdir: m[2] };
  return null;
}


function tarballUrlFor(cloneUrl: string): string | null {
  const m = cloneUrl.match(
    /^(?:https?:\/\/|git@)github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
  );
  if (!m?.[1]) return null;
  return `https://codeload.github.com/${m[1]}/tar.gz/refs/heads/main`;
}


async function acquireRepository(cloneUrl: string, target: string): Promise<boolean> {
  const gitCheck = Bun.spawnSync(["git", "--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (gitCheck.exitCode === 0) {
    const result = Bun.spawnSync(["git", "clone", "--depth", "1", cloneUrl, target], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.exitCode === 0) return true;
    
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
    if (rel === ".." || rel.startsWith(`..${sep}`)) continue; 
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }
  return null;
}


function isPluginDir(dir: string): boolean {
  return (
    existsSync(join(dir, ".claude-plugin", "plugin.json")) ||
    existsSync(join(dir, "manifest.json"))
  );
}


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


async function installPluginFromManifestUrl(name: string, url: string): Promise<boolean> {
  let cleanUrl = url.trim().replace(/\.git$/, "");
  if (cleanUrl.startsWith("https://github.com/")) {
    cleanUrl = cleanUrl.replace("https://github.com/", "https://raw.githubusercontent.com/");
    
    cleanUrl = `${cleanUrl}/main/manifest.json`;
  } else if (!cleanUrl.endsWith("manifest.json")) {
    cleanUrl = `${cleanUrl}/manifest.json`;
  }

  try {
    const res = await fetchWithTimeout(cleanUrl);
    if (!res || !res.ok) return false;
    const manifest = (await res.json()) as PluginManifest;

    
    const pluginName = manifest.name || name;
    const destDir = join(PLUGINS_DIR, pluginName);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

    writeFileSync(join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}


export async function installPlugin(name: string, repository: string): Promise<boolean> {
  ensureDirs();
  const repo = (repository ?? "").trim();
  if (!repo) return false;

  
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
  
  
  const pluginSubdir =
    subdir && subdir.endsWith("/.claude-plugin") ? subdir.slice(0, -"/.claude-plugin".length) : subdir;

  const tmpRoot = join(DATA_DIR, `.plugin-install-${process.pid}-${Date.now()}`);
  const tmpRepo = join(tmpRoot, "repo");
  try {
    mkdirSync(tmpRoot, { recursive: true });
    if (!(await acquireRepository(cloneUrl, tmpRepo))) return false;

    
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
