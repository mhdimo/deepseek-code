






















import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AgentConfig,
  PermissionRuleset,
} from "../types/index.js";




export interface CustomAgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  permissions: Partial<PermissionRuleset>;
  maxSteps?: number;
  model?: string;
  
  displayName?: string;
  
  temperature?: number;
  
  maxTokens?: number;
}


export interface CustomAgentConfig extends Omit<AgentConfig, "name"> {
  name: string;
  
  model?: string;
}



const DEFAULT_MAX_STEPS = 25;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 16384;


const DEFAULT_PERMISSIONS: PermissionRuleset = {
  allowRead: true,
  allowWrite: false,
  allowExecute: false,
  allowNetwork: false,
};




export function globalAgentsDir(): string {
  return join(homedir(), ".deepseek-code", "agents");
}


export function projectAgentsDir(cwd: string): string {
  return join(cwd, ".deepseek-code", "agents");
}



const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;


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




function loadFile(filePath: string): CustomAgentDefinition | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isValidDefinition(parsed) ? parsed : null;
  } catch {
    return null;
  }
}


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


export function loadCustomAgentDefinitions(cwd: string): Map<string, CustomAgentDefinition> {
  const out = new Map<string, CustomAgentDefinition>();
  
  for (const dir of [globalAgentsDir(), projectAgentsDir(cwd)]) {
    for (const filePath of listJsonFiles(dir)) {
      const def = loadFile(filePath);
      if (def) out.set(def.name, def);
    }
  }
  return out;
}



function titleCase(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}


function resolvePermissions(def: CustomAgentDefinition): PermissionRuleset {
  const perms = def.permissions ?? {};
  return {
    allowRead: perms.allowRead ?? DEFAULT_PERMISSIONS.allowRead,
    allowWrite: perms.allowWrite ?? DEFAULT_PERMISSIONS.allowWrite,
    allowExecute: perms.allowExecute ?? DEFAULT_PERMISSIONS.allowExecute,
    allowNetwork: perms.allowNetwork ?? DEFAULT_PERMISSIONS.allowNetwork,
  };
}


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




export function listCustomAgents(cwd: string): CustomAgentConfig[] {
  return [...loadCustomAgentDefinitions(cwd).values()].map(toCustomAgentConfig);
}


export function getCustomAgent(cwd: string, name: string): CustomAgentConfig | undefined {
  const def = loadCustomAgentDefinitions(cwd).get(name);
  return def ? toCustomAgentConfig(def) : undefined;
}


export function mergeWithBuiltin(
  builtins: AgentConfig[],
  cwd: string,
): AgentConfig[] {
  const builtinNames = new Set(builtins.map((a) => a.name));
  const merged: AgentConfig[] = [...builtins];
  for (const custom of listCustomAgents(cwd)) {
    if (builtinNames.has(custom.name as never)) continue;
    
    
    
    merged.push(custom as unknown as AgentConfig);
  }
  return merged;
}
