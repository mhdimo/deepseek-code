// Custom agents — user-defined agent definitions loaded from disk.
//
// Loads agent JSON files from two locations (later sources override earlier
// ones on name collision):
//   1. ~/.deepseek-code/agents/*.json      (user-global)
//   2. <cwd>/.deepseek-code/agents/*.json  (project-local)
//
// Each file has the shape:
//   {
//     "name": "string (kebab-case identifier, e.g. 'docs')",
//     "description": "short one-liner shown in the /agent picker",
//     "systemPrompt": "full system prompt for the agent",
//     "permissions": { "allowRead": bool, "allowWrite": bool,
//                      "allowExecute": bool, "allowNetwork": bool },
//     "maxSteps": 25,            // optional, default 25
//     "model": "deepseek-chat"   // optional model override
//   }
//
// Pure TS — no C++ changes. Custom agents reuse the existing Agent class and
// C++ Session; they only differ in config (systemPrompt, permissions, steps).
// The name is intentionally typed as `string` (not the closed AgentName union)
// so custom agents can carry arbitrary identifiers without touching shared types.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AgentConfig,
  PermissionRuleset,
} from "../types/index.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * On-disk shape of a custom agent definition. `name`, `description`,
 * `systemPrompt`, and `permissions` are required; the rest are optional.
 */
export interface CustomAgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  permissions: Partial<PermissionRuleset>;
  maxSteps?: number;
  model?: string;
  /** Optional display name; defaults to a title-cased `name`. */
  displayName?: string;
  /** Optional sampling temperature. */
  temperature?: number;
  /** Optional max output tokens. */
  maxTokens?: number;
}

/**
 * A custom agent config — same surface as AgentConfig but with a `string`
 * name and an optional `model` override, so callers can swap the provider
 * model when instantiating the agent.
 */
export interface CustomAgentConfig extends Omit<AgentConfig, "name"> {
  name: string;
  /** Optional model override; integrator may set ProviderConfig.model to this. */
  model?: string;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 16384;

/** Sensible read-only default; merged with the definition's permissions. */
const DEFAULT_PERMISSIONS: PermissionRuleset = {
  allowRead: true,
  allowWrite: false,
  allowExecute: false,
  allowNetwork: false,
};

// ─── Paths ──────────────────────────────────────────────────────────────────

/** User-global custom agents directory: ~/.deepseek-code/agents */
export function globalAgentsDir(): string {
  return join(homedir(), ".deepseek-code", "agents");
}

/** Project-local custom agents directory: <cwd>/.deepseek-code/agents */
export function projectAgentsDir(cwd: string): string {
  return join(cwd, ".deepseek-code", "agents");
}

// ─── Validation ─────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

/**
 * Validate a parsed JSON object against CustomAgentDefinition.
 * Returns the definition on success, or null (logging nothing) on failure —
 * the caller decides whether to surface the skip. We tolerate unknown keys
 * so users can add forward-compatible fields.
 */
function isValidDefinition(value: unknown): value is CustomAgentDefinition {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" && NAME_RE.test(v.name) &&
    typeof v.description === "string" && v.description.trim().length > 0 &&
    typeof v.systemPrompt === "string" && v.systemPrompt.trim().length > 0 &&
    (v.permissions === undefined || typeof v.permissions === "object")
  );
}

// ─── Loading ────────────────────────────────────────────────────────────────

/** Read & parse a single agent file. Returns null on any error. */
function loadFile(filePath: string): CustomAgentDefinition | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isValidDefinition(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** List all *.json file paths in a directory (empty if missing/unreadable). */
function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Load custom agent definitions from disk. Project-local files override
 * global files with the same `name`.
 *
 * @param cwd  Current working directory (for project-local agents).
 * @returns    Map keyed by agent name → definition.
 */
export function loadCustomAgentDefinitions(cwd: string): Map<string, CustomAgentDefinition> {
  const out = new Map<string, CustomAgentDefinition>();
  // Global first, then project-local so project wins on collision.
  for (const dir of [globalAgentsDir(), projectAgentsDir(cwd)]) {
    for (const filePath of listJsonFiles(dir)) {
      const def = loadFile(filePath);
      if (def) out.set(def.name, def);
    }
  }
  return out;
}

// ─── Conversion ─────────────────────────────────────────────────────────────

function titleCase(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

/** Merge a definition's partial permissions over the safe read-only defaults. */
function resolvePermissions(def: CustomAgentDefinition): PermissionRuleset {
  const perms = def.permissions ?? {};
  return {
    allowRead: perms.allowRead ?? DEFAULT_PERMISSIONS.allowRead,
    allowWrite: perms.allowWrite ?? DEFAULT_PERMISSIONS.allowWrite,
    allowExecute: perms.allowExecute ?? DEFAULT_PERMISSIONS.allowExecute,
    allowNetwork: perms.allowNetwork ?? DEFAULT_PERMISSIONS.allowNetwork,
  };
}

/** Convert a definition into a runtime CustomAgentConfig. */
export function toCustomAgentConfig(def: CustomAgentDefinition): CustomAgentConfig {
  return {
    name: def.name,
    displayName: def.displayName ?? titleCase(def.name),
    description: def.description,
    systemPrompt: def.systemPrompt,
    temperature: def.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: def.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxSteps: def.maxSteps ?? DEFAULT_MAX_STEPS,
    permissions: resolvePermissions(def),
    model: def.model,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * List all custom agents as runtime configs.
 * Reads from disk on each call (cheap: a few small JSON files) so edits are
 * picked up without a restart.
 */
export function listCustomAgents(cwd: string): CustomAgentConfig[] {
  return [...loadCustomAgentDefinitions(cwd).values()].map(toCustomAgentConfig);
}

/** Look up a single custom agent by name. Returns undefined if not found. */
export function getCustomAgent(cwd: string, name: string): CustomAgentConfig | undefined {
  const def = loadCustomAgentDefinitions(cwd).get(name);
  return def ? toCustomAgentConfig(def) : undefined;
}

/**
 * Merge custom agents into a set of built-in AgentConfigs.
 * Custom agents are appended after built-ins. A custom agent whose name
 * collides with a built-in is skipped (built-ins always win) so users can't
 * accidentally shadow the `code`/`plan`/`review` agents.
 *
 * @param builtins  Built-in AgentConfigs (e.g. from AgentManager.listAgents()).
 * @param cwd       Current working directory (for project-local agents).
 * @returns         A new array: built-ins first, then unique custom agents.
 */
export function mergeWithBuiltin(
  builtins: AgentConfig[],
  cwd: string,
): AgentConfig[] {
  const builtinNames = new Set(builtins.map((a) => a.name));
  const merged: AgentConfig[] = [...builtins];
  for (const custom of listCustomAgents(cwd)) {
    if (builtinNames.has(custom.name as never)) continue;
    // CustomAgentConfig is a structural superset of AgentConfig (its `name`
    // is `string` vs the closed `AgentName` union). The cast is safe: callers
    // treat `name` as an opaque identifier and never narrow on the literal.
    merged.push(custom as unknown as AgentConfig);
  }
  return merged;
}
