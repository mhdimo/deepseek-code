// Configuration loading — env vars → config file → CLI args
//
// Config supports named model "profiles", each with its own API key, plus
// optional MCP server definitions.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type {
  DeepSeekCodeConfig,
  ProviderType,
  AgentName,
  ModelProfile,
  MCPServerConfig,
} from "./types.js";

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULTS: DeepSeekCodeConfig = {
  provider: "deepseek",
  model: "deepseek-chat",
  apiKey: "",
  defaultAgent: "code",
  maxSteps: 25,
  dangerouslySkipPermissions: false,
};

// ─── Resolve "env:VAR_NAME" references ─────────────────────────────────────

function resolveEnvRef(value: string): string {
  if (value.startsWith("env:")) {
    return process.env[value.slice(4)] || "";
  }
  return value;
}

// ─── Config file paths ─────────────────────────────────────────────────────

const CONFIG_PATHS = [
  join(process.cwd(), ".deepseek-code.json"),
  join(homedir(), ".config", "deepseek-code", "config.json"),
  join(homedir(), ".deepseek-code.json"),
  // Legacy paths for backward compatibility
  join(process.cwd(), ".zcode.json"),
  join(homedir(), ".config", "z-code", "config.json"),
  join(homedir(), ".zcode.json"),
];

function loadConfigFile(): Partial<DeepSeekCodeConfig> {
  for (const path of CONFIG_PATHS) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<DeepSeekCodeConfig>;

      // Resolve env refs in top-level apiKey
      if (typeof parsed.apiKey === "string") {
        parsed.apiKey = resolveEnvRef(parsed.apiKey);
      }

      // Resolve env refs in every profile's apiKey
      if (parsed.profiles && typeof parsed.profiles === "object") {
        for (const [, profile] of Object.entries(parsed.profiles)) {
          const p = profile as ModelProfile;
          if (typeof p.apiKey === "string") {
            p.apiKey = resolveEnvRef(p.apiKey);
          }
        }
      }

      // Resolve env refs in MCP server env values
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
      // Skip invalid config files
    }
  }
  return {};
}

// ─── Environment variables ─────────────────────────────────────────────────

function loadEnvConfig(): Partial<DeepSeekCodeConfig> {
  const config: Partial<DeepSeekCodeConfig> = {};

  if (process.env.DEEPSEEK_PROVIDER) config.provider = process.env.DEEPSEEK_PROVIDER as ProviderType;
  if (process.env.DEEPSEEK_MODEL) config.model = process.env.DEEPSEEK_MODEL;
  if (process.env.DEEPSEEK_BASE_URL) config.baseURL = process.env.DEEPSEEK_BASE_URL;
  if (process.env.DEEPSEEK_MAX_STEPS) config.maxSteps = parseInt(process.env.DEEPSEEK_MAX_STEPS, 10);
  if (process.env.DEEPSEEK_AGENT) config.defaultAgent = process.env.DEEPSEEK_AGENT as AgentName;

  // Support multiple key env vars for convenience
  config.apiKey =
    process.env.DEEPSEEK_API_KEY ||
    process.env.ZCODE_API_KEY || // Legacy support
    "";

  return config;
}

// ─── CLI argument parsing ──────────────────────────────────────────────────

function parseCliArgs(): Partial<DeepSeekCodeConfig> & { help?: boolean; version?: boolean } {
  const args = process.argv.slice(2);
  const config: Partial<DeepSeekCodeConfig> & { help?: boolean; version?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];

    switch (arg) {
      case "--provider":
      case "-p":
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
    }
  }

  return config;
}

// ─── Help text ─────────────────────────────────────────────────────────────

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
  --max-steps <n>               Max tool-call steps per turn (default: 25)
  --dangerously-skip-permissions  Skip permission prompts for tools
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

// ─── Main loader ───────────────────────────────────────────────────────────

export function loadConfig(): DeepSeekCodeConfig & { help?: boolean; version?: boolean } {
  const fileConfig = loadConfigFile();
  const envConfig = loadEnvConfig();
  const cliConfig = parseCliArgs();

  // Merge: defaults ← file ← env ← cli (cli wins)
  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...cliConfig,
  };

  // Filter out empty strings
  if (!merged.apiKey) merged.apiKey = "";

  // Ensure provider is always deepseek
  merged.provider = "deepseek";

  return merged as DeepSeekCodeConfig & { help?: boolean; version?: boolean };
}
