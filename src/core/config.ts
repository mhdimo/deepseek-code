// Configuration loading — env vars → config file → CLI args
//
// Config supports named model "profiles", each with its own API key, plus
// optional MCP server definitions.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type {
  ZCodeConfig,
  ProviderType,
  AgentName,
  ModelProfile,
  MCPServerConfig,
} from "./types.js";

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULTS: ZCodeConfig = {
  provider: "openai",
  model: "gpt-4o",
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
  join(process.cwd(), ".zcode.json"),
  join(homedir(), ".config", "z-code", "config.json"),
  join(homedir(), ".zcode.json"),
];

function loadConfigFile(): Partial<ZCodeConfig> {
  for (const path of CONFIG_PATHS) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ZCodeConfig>;

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

function loadEnvConfig(): Partial<ZCodeConfig> {
  const config: Partial<ZCodeConfig> = {};

  if (process.env.ZCODE_PROVIDER) config.provider = process.env.ZCODE_PROVIDER as ProviderType;
  if (process.env.ZCODE_MODEL) config.model = process.env.ZCODE_MODEL;
  if (process.env.ZCODE_BASE_URL) config.baseURL = process.env.ZCODE_BASE_URL;
  if (process.env.ZCODE_MAX_STEPS) config.maxSteps = parseInt(process.env.ZCODE_MAX_STEPS, 10);
  if (process.env.ZCODE_AGENT) config.defaultAgent = process.env.ZCODE_AGENT as AgentName;

  // Support multiple key env vars
  config.apiKey =
    process.env.ZCODE_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    "";

  return config;
}

// ─── CLI argument parsing ──────────────────────────────────────────────────

function parseCliArgs(): Partial<ZCodeConfig> & { help?: boolean; version?: boolean } {
  const args = process.argv.slice(2);
  const config: Partial<ZCodeConfig> & { help?: boolean; version?: boolean } = {};

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
z-code — Terminal-native AI coding agent

Usage: z-code [options]

Options:
  -p, --provider <type>         Provider: openai, anthropic (default: openai)
  -m, --model <name>            Model name (default: gpt-4o)
  -k, --api-key <key>           API key (or set ZCODE_API_KEY)
  -u, --base-url <url>          Custom API base URL (for OpenAI-compatible endpoints)
  -a, --agent <name>            Default agent: code, plan, review (default: code)
  --max-steps <n>               Max tool-call steps per turn (default: 25)
  --dangerously-skip-permissions  Skip permission prompts for tools
  -h, --help                    Show this help
  -v, --version                 Show version

Environment:
  ZCODE_API_KEY          API key (also reads OPENAI_API_KEY, ANTHROPIC_API_KEY)
  ZCODE_PROVIDER         Provider type
  ZCODE_MODEL            Model name
  ZCODE_BASE_URL         Custom base URL

Config file:
  .zcode.json in cwd, or ~/.config/z-code/config.json

Examples:
  # Use OpenAI
  z-code --provider openai --model gpt-4o

  # Use Claude
  z-code --provider anthropic --model claude-sonnet-4-20250514

  # Use GLM-4 via OpenAI-compatible endpoint
  z-code --provider openai --model glm-4 --base-url https://open.bigmodel.cn/api/v1

  # Use DeepSeek
  z-code --provider openai --model deepseek-chat --base-url https://api.deepseek.com/v1

  # Use Groq
  z-code --provider openai --model llama-3.3-70b-versatile --base-url https://api.groq.com/openai/v1

  # MCP servers from config (then use /mcp in the app)
  z-code
`);
}

// ─── Main loader ───────────────────────────────────────────────────────────

export function loadConfig(): ZCodeConfig & { help?: boolean; version?: boolean } {
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

  return merged as ZCodeConfig & { help?: boolean; version?: boolean };
}
