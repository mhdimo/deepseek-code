





import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type {
  DeepSeekCodeConfig,
  ConfigPermissionRules,
  ProviderType,
  AgentName,
  ModelProfile,
  MCPServerConfig,
} from "../types/index.js";
import { loadSettings } from "../state/storage.js";
import type { EffortLevel } from "../state/storage.js";
import { isTrusted } from "../services/projectTrust.js";
import type { ThemeSetting } from "./theme.js";



const DEFAULTS: DeepSeekCodeConfig = {
  provider: "deepseek",
  model: "deepseek-chat",
  apiKey: "",
  defaultAgent: "code",
  maxSteps: 25,
  dangerouslySkipPermissions: false,
};



function resolveEnvRef(value: string): string {
  if (value.startsWith("env:")) {
    return process.env[value.slice(4)] || "";
  }
  return value;
}



/**
 * Config that lives in the workspace. A cloned repo can carry one of these, and
 * it can do two things worth caring about: declare MCP servers, which are
 * commands this process will execute, and redirect `baseURL`, which sends the
 * user's API key to a host of the repo author's choosing. Neither is something
 * opening a folder should be able to do, so these paths are consulted only once
 * the directory is trusted.
 */
function projectConfigPaths(dir: string): string[] {
  return [join(dir, ".deepseek-code.json"), join(dir, ".zcode.json")];
}

/**
 * The workspace config files a caller may read *or write* right now — none,
 * until the directory is trusted.
 *
 * Writes matter as much as reads here. Persisting a user's toggle into a file
 * the app has decided not to honor would either do nothing on the next run (the
 * change is silently dropped) or apply later, the moment the directory is
 * trusted. Callers that touch workspace config must ask through here rather
 * than rebuilding the path list, so one trust decision governs every direction.
 */
export function activeProjectConfigPaths(dir: string = process.cwd()): string[] {
  return isTrusted(dir) ? projectConfigPaths(dir) : [];
}

/** Config that belongs to the user, not to whatever directory they are in. */
const USER_CONFIG_PATHS = [
  join(homedir(), ".config", "deepseek-code", "config.json"),
  join(homedir(), ".deepseek-code.json"),
  join(homedir(), ".config", "z-code", "config.json"),
  join(homedir(), ".zcode.json"),
];

/** The workspace's own config file, if it has one. Drives the trust prompt. */
export function findProjectConfig(dir: string): string | null {
  return projectConfigPaths(dir).find((p) => existsSync(p)) ?? null;
}

/**
 * Read only the workspace's own config, for applying it the moment the user
 * grants trust (rather than waiting for a restart).
 */
export function loadProjectConfig(dir: string): Partial<DeepSeekCodeConfig> {
  for (const path of projectConfigPaths(dir)) {
    if (!existsSync(path)) continue;
    const parsed = parseConfigFile(path);
    if (parsed) return parsed;
  }
  return {};
}

/** Workspace rules, cached against the file's mtime the way loadSettings caches
 *  the user's — this is consulted on every tool call. */
let projectPermissionsCache: { path: string; mtimeMs: number; rules: ConfigPermissionRules | null } | null =
  null;

/**
 * The workspace's permission rules, or null when it has none or is not trusted.
 *
 * Trust decides this, exactly as it decides every other read of workspace
 * config, and for a sharper reason: this file can approve tools. An untrusted
 * directory has no config paths at all, so a cloned repo cannot hand itself
 * `allow: ["Bash"]` by shipping one. `/permissions` hides the "Project
 * settings" destination in the same state, so rules can only be written where
 * they will be read.
 */
export function loadProjectPermissions(dir: string = process.cwd()): ConfigPermissionRules | null {
  const path = activeProjectConfigPaths(dir).find((p) => existsSync(p));
  if (!path) return null;

  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (
      projectPermissionsCache &&
      projectPermissionsCache.path === path &&
      projectPermissionsCache.mtimeMs === mtimeMs
    ) {
      return projectPermissionsCache.rules;
    }
    const rules = coercePermissionRules(parseConfigFile(path)?.permissions);
    projectPermissionsCache = { path, mtimeMs, rules };
    return rules;
  } catch {
    // A config we cannot read must not become an error in the middle of a
    // tool call, and must not become a set of rules either.
    return null;
  }
}

/** The rules keys are whatever is in the file: a hand-written config can hold a
 *  string where a list belongs, and a string is iterable — `"Bash"` would arrive
 *  as four one-letter rules. Anything that is not a list of strings is dropped. */
function coercePermissionRules(value: unknown): ConfigPermissionRules | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out: ConfigPermissionRules = {};
  let found = false;
  for (const behavior of ["allow", "ask", "deny"] as const) {
    const list = source[behavior];
    if (!Array.isArray(list)) continue;
    const rules = list.filter((r): r is string => typeof r === "string" && r.trim().length > 0);
    if (rules.length > 0) {
      out[behavior] = rules;
      found = true;
    }
  }
  return found ? out : null;
}

function parseConfigFile(path: string): Partial<DeepSeekCodeConfig> | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeepSeekCodeConfig>;


    if (typeof parsed.apiKey === "string") {
      parsed.apiKey = resolveEnvRef(parsed.apiKey);
    }


    if (parsed.profiles && typeof parsed.profiles === "object") {
      for (const [, profile] of Object.entries(parsed.profiles)) {
        const p = profile as ModelProfile;
        if (typeof p.apiKey === "string") {
          p.apiKey = resolveEnvRef(p.apiKey);
        }
      }
    }


    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
      for (const [, server] of Object.entries(parsed.mcpServers)) {
        const s = server as MCPServerConfig;
        if (s.env && typeof s.env === "object") {
          for (const [k, v] of Object.entries(s.env)) {
            if (typeof v === "string") s.env[k] = resolveEnvRef(v);
          }
        }
      }
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Config files in priority order, and the merge across them.
 *
 * Everything is first-file-wins — a project file overrides the user's — except
 * `mcpServers`, which no file owns. The whole-config resolution below reads
 * only the first file that exists, which meant that the moment a workspace had
 * a `.deepseek-code.json` of its own, every server the user had configured for
 * themselves disappeared: no error, no notice, just a tool list with the MCP
 * tools quietly missing, and the natural reading of that is "the server broke".
 * Servers are named, so the two scopes can be merged without ambiguity, and a
 * project redefining a user's server wins, because that is what a project file
 * is for.
 *
 * Exported for the test: the ordering rule is the whole of it, and it is worth
 * pinning without a filesystem.
 */
export function mergeConfigScopes(
  found: Array<{ path: string; parsed: Partial<DeepSeekCodeConfig> }>,
): Partial<DeepSeekCodeConfig> {
  const first = found[0];
  if (!first) return {};

  const merged: Record<string, MCPServerConfig> = {};
  // Reverse order so the highest-priority file assigns last.
  for (let i = found.length - 1; i >= 0; i--) {
    const servers = found[i]?.parsed.mcpServers;
    if (servers) Object.assign(merged, servers);
  }

  return Object.keys(merged).length > 0
    ? { ...first.parsed, mcpServers: merged }
    : first.parsed;
}

function loadConfigFile(): Partial<DeepSeekCodeConfig> {
  const paths = [...activeProjectConfigPaths(), ...USER_CONFIG_PATHS];

  const found: Array<{ path: string; parsed: Partial<DeepSeekCodeConfig> }> = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const parsed = parseConfigFile(path);
    if (parsed) found.push({ path, parsed });
  }

  return mergeConfigScopes(found);
}



function loadEnvConfig(): Partial<DeepSeekCodeConfig> {
  const config: Partial<DeepSeekCodeConfig> = {};

  if (process.env.DEEPSEEK_PROVIDER) config.provider = process.env.DEEPSEEK_PROVIDER as ProviderType;
  if (process.env.DEEPSEEK_MODEL) config.model = process.env.DEEPSEEK_MODEL;
  if (process.env.DEEPSEEK_BASE_URL) config.baseURL = process.env.DEEPSEEK_BASE_URL;
  if (process.env.DEEPSEEK_MAX_STEPS) config.maxSteps = parseInt(process.env.DEEPSEEK_MAX_STEPS, 10);
  if (process.env.DEEPSEEK_AGENT) config.defaultAgent = process.env.DEEPSEEK_AGENT as AgentName;

  
  config.apiKey =
    process.env.DEEPSEEK_API_KEY ||
    process.env.ZCODE_API_KEY || 
    "";

  return config;
}



function parseCliArgs(): Partial<DeepSeekCodeConfig> & { help?: boolean; version?: boolean; resumeSession?: string; effort?: EffortLevel } {
  const args = process.argv.slice(2);
  const config: Partial<DeepSeekCodeConfig> & { help?: boolean; version?: boolean; resumeSession?: string; effort?: EffortLevel } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];

    switch (arg) {
      case "--provider":
        config.provider = next as ProviderType;
        i++;
        break;
      case "--model":
      case "-m":
        config.model = next;
        i++;
        break;
      case "--api-key":
      case "-k":
        config.apiKey = next;
        i++;
        break;
      case "--base-url":
      case "-u":
        config.baseURL = next;
        i++;
        break;
      case "--max-steps":
        config.maxSteps = parseInt(next || "25", 10);
        i++;
        break;
      case "--agent":
      case "-a":
        config.defaultAgent = next as AgentName;
        i++;
        break;
      case "--effort":
        config.effort = next as EffortLevel;
        i++;
        break;
      case "--dangerously-skip-permissions":
        config.dangerouslySkipPermissions = true;
        break;
      case "--help":
      case "-h":
        config.help = true;
        break;
      case "--version":
      case "-v":
        config.version = true;
        break;
      case "--resume":
      case "-r":
        if (next && !next.startsWith("-")) {
          (config as any).resumeSession = next;
          i++;
        } else {
          (config as any).resumeSession = "latest";
        }
        break;
      
      case "--print":
      case "-p": {
        const np = args[i + 1];
        if (np && !np.startsWith("-")) {
          (config as any).print = np;
          i++;
        } else {
          
          (config as any).print = "";
        }
        break;
      }
      case "--output-format":
        (config as any).printOutputFormat = next === "json" ? "json" : "text";
        i++;
        break;
      case "--max-turns":
        (config as any).printMaxTurns = parseInt(next || "0", 10);
        i++;
        break;
      case "--system-prompt-file":
        (config as any).printSystemPromptFile = next;
        i++;
        break;
      case "--verbose":
      case "-V":
        (config as any).printVerbose = true;
        break;
      case "--stream":
        (config as any).printStreamText = true;
        break;
    }
  }

  return config;
}



export function printHelp(): void {
  console.log(`
DeepSeek Code — Terminal-native AI coding agent

Usage: deepseek-code [options]

Options:
  -m, --model <name>            Model name (default: deepseek-chat)
                                Available: deepseek-chat, deepseek-reasoner
  -k, --api-key <key>           API key (or set DEEPSEEK_API_KEY)
  -u, --base-url <url>          Custom API base URL (default: https://api.deepseek.com/v1)
  -a, --agent <name>            Default agent: code, plan, review (default: code)
      --effort <level>          Reasoning effort: off, low, medium, high, max (default: off)
  --max-steps <n>               Max tool-call steps per turn (default: 25)
  --dangerously-skip-permissions  Skip permission prompts for tools
  -r, --resume <hash>           Resume a saved session
  -p, --print [prompt]          Non-interactive: run one prompt, print, exit (stdin if no arg)
      --output-format <fmt>     --print output: text (default) or json
      --max-turns <n>           Max tool-call turns for --print
      --system-prompt-file <f>  Replace the system prompt with the file's contents
      --stream                  Stream --print text deltas live to stdout
      --verbose                 Stream tool progress to stderr in --print
  -h, --help                    Show this help
  -v, --version                 Show version

Environment:
  DEEPSEEK_API_KEY        API key for DeepSeek
  DEEPSEEK_MODEL          Model name (deepseek-chat or deepseek-reasoner)
  DEEPSEEK_BASE_URL       Custom base URL (for proxies)

Config file:
  .deepseek-code.json in cwd, or ~/.config/deepseek-code/config.json

Examples:
  # Use default DeepSeek Chat
  deepseek-code

  # Use DeepSeek Reasoner for complex reasoning tasks
  deepseek-code --model deepseek-reasoner

  # With API key from command line
  deepseek-code --api-key sk-xxxxx

  # With custom endpoint (proxy)
  deepseek-code --base-url https://your-proxy.com/v1
`);
}



export function loadConfig(): DeepSeekCodeConfig & { help?: boolean; version?: boolean; resumeSession?: string; effort?: EffortLevel } {
  const fileConfig = loadConfigFile();
  const envConfig = loadEnvConfig();
  const persistedConfig = loadPersistedSettings();
  const cliConfig = parseCliArgs();

  
  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...persistedConfig,
    ...cliConfig,
  };

  
  if (!merged.apiKey) merged.apiKey = "";

  
  merged.provider = "deepseek";

  return merged as DeepSeekCodeConfig & { help?: boolean; version?: boolean };
}


function loadPersistedSettings(): Partial<DeepSeekCodeConfig> & { themeMode?: ThemeSetting; effort?: EffortLevel } {
  const settings = loadSettings();
  const config: Partial<DeepSeekCodeConfig> & { themeMode?: ThemeSetting; effort?: EffortLevel } = {};
  if (settings.apiKey) config.apiKey = settings.apiKey;
  if (settings.model) config.model = settings.model;
  if (settings.baseURL) config.baseURL = settings.baseURL;
  if (settings.defaultAgent) config.defaultAgent = settings.defaultAgent as AgentName;
  if (settings.themeMode) config.themeMode = settings.themeMode;
  if (settings.effort) config.effort = settings.effort;
  // Only ever set from here, never cleared. `false` is already the default and
  // an absent key means the same thing, so copying a stored `false` across
  // would achieve nothing except letting an empty settings file cancel a
  // `true` that came from the config file.
  if (settings.dangerouslySkipPermissions) config.dangerouslySkipPermissions = true;
  return config;
}
