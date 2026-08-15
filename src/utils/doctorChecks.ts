/**
 * doctorChecks.ts — diagnostic logic for the /doctor view.
 *
 * Pure-ish check functions (fs reads allowed, no UI). Sections mirror the
 * Claude Code doctor: context usage warnings, unreachable permission rules,
 * invalid settings, agent parse errors, plugin errors, MCP config parsing
 * warnings, and env-var bounds.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PersistedSettings } from "../state/storage.js";
import { loadSettings } from "../state/storage.js";
import {
  matchGlob,
  matchShellCommand,
  matchWildcardPattern,
  parsePermissionSettings,
  type ParsedRule,
} from "../services/permissions.js";
import { estimateTokens } from "./limits.js";
import { listDiscoveredAgents } from "../services/agents/agentDiscovery.js";
import { loadConfig } from "./config.js";

export type { ParsedRule } from "../services/permissions.js";

// Thresholds (mirroring claude-code-main's doctor checks).
export const MAX_MEMORY_CHARACTER_COUNT = 40_000;
export const AGENT_DESCRIPTIONS_THRESHOLD = 15_000;
export const MCP_TOOLS_THRESHOLD = 25_000;

/** A single per-file parse/validation problem. */
export interface FileError {
  path: string;
  error: string;
}

/** A settings-key validation problem. */
export interface SettingsError {
  key: string;
  message: string;
}

export type ContextWarningType =
  | "claudemd_files"
  | "agent_descriptions"
  | "mcp_tools"
  | "unreachable_rules";

export interface ContextWarning {
  type: ContextWarningType;
  severity: "warning" | "error";
  message: string;
  details: string[];
  currentValue: number;
  threshold: number;
}

export interface ContextWarnings {
  claudeMdWarning: ContextWarning | null;
  agentWarning: ContextWarning | null;
  mcpWarning: ContextWarning | null;
  unreachableRulesWarning: ContextWarning | null;
}

// ── Context usage warnings ────────────────────────────────────────────────

export interface MemoryFile {
  path: string;
  content: string;
}

/** Memory docs that land in the agent's context (same surface as
 *  agentSession's CLAUDE.md/DEEP.md/AGENTS.md injection, plus the
 *  .claude variants Claude Code reads). */
export function getMemoryFiles(cwd: string = process.cwd()): MemoryFile[] {
  const home = homedir();
  const candidates = [
    join(cwd, ".claude", "CLAUDE.md"),
    join(cwd, ".claude", "CLAUDE.local.md"),
    join(cwd, "CLAUDE.md"),
    join(cwd, "DEEP.md"),
    join(cwd, "AGENTS.md"),
    join(home, ".claude", "CLAUDE.md"),
    join(home, ".claude", "CLAUDE.local.md"),
    join(home, ".deepseek-code", "CLAUDE.md"),
  ];
  const out: MemoryFile[] = [];
  for (const path of candidates) {
    try {
      if (existsSync(path)) out.push({ path, content: readFileSync(path, "utf-8") });
    } catch {
      // unreadable files are not context warnings
    }
  }
  return out;
}

/** Files larger than MAX_MEMORY_CHARACTER_COUNT chars, largest first. */
export function getLargeMemoryFiles(files: readonly MemoryFile[]): MemoryFile[] {
  return files
    .filter((f) => f.content.length > MAX_MEMORY_CHARACTER_COUNT)
    .sort((a, b) => b.content.length - a.content.length);
}

export function checkClaudeMdWarnings(
  files: readonly MemoryFile[] = getMemoryFiles(),
): ContextWarning | null {
  const large = getLargeMemoryFiles(files);
  if (large.length === 0) return null;

  const details = large.map((f) => `${f.path}: ${f.content.length.toLocaleString()} chars`);
  const message =
    large.length === 1
      ? `Large CLAUDE.md file detected (${large[0]!.content.length.toLocaleString()} chars > ${MAX_MEMORY_CHARACTER_COUNT.toLocaleString()})`
      : `${large.length} large CLAUDE.md files detected (each > ${MAX_MEMORY_CHARACTER_COUNT.toLocaleString()} chars)`;

  return {
    type: "claudemd_files",
    severity: "warning",
    message,
    details,
    currentValue: large.length,
    threshold: MAX_MEMORY_CHARACTER_COUNT,
  };
}

/** Combined token estimate of custom-agent descriptions (built-ins excluded,
 *  matching the reference check). */
export function checkAgentDescriptionWarnings(): ContextWarning | null {
  const agents = listDiscoveredAgents();
  if (agents.length === 0) return null;

  const per = agents
    .map((a) => ({
      name: a.name,
      tokens: estimateTokens(`${a.name}: ${a.description}`),
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const totalTokens = per.reduce((sum, a) => sum + a.tokens, 0);
  if (totalTokens <= AGENT_DESCRIPTIONS_THRESHOLD) return null;

  const details = per.slice(0, 5).map((a) => `${a.name}: ~${a.tokens.toLocaleString()} tokens`);
  if (per.length > 5) details.push(`(${per.length - 5} more custom agents)`);

  return {
    type: "agent_descriptions",
    severity: "warning",
    message: `Large agent descriptions (~${totalTokens.toLocaleString()} tokens > ${AGENT_DESCRIPTIONS_THRESHOLD.toLocaleString()})`,
    details,
    currentValue: totalTokens,
    threshold: AGENT_DESCRIPTIONS_THRESHOLD,
  };
}

/** Token estimate of configured MCP servers (name + command + args). The
 *  native engine owns the real tool list, so this mirrors the reference
 *  check over what the port can see statically. */
export function checkMcpContextWarnings(): ContextWarning | null {
  const servers = loadConfig().mcpServers;
  if (!servers || typeof servers !== "object") return null;

  const per: Array<{ name: string; tokens: number }> = [];
  let totalTokens = 0;
  for (const [name, srv] of Object.entries(servers)) {
    if (!srv || typeof srv !== "object") continue;
    const cmd = typeof srv.command === "string" ? srv.command : "";
    const args = Array.isArray(srv.args)
      ? srv.args.filter((a): a is string => typeof a === "string").join(" ")
      : "";
    const tokens = estimateTokens(`${name}: ${cmd} ${args}`.trim());
    per.push({ name, tokens });
    totalTokens += tokens;
  }
  if (totalTokens <= MCP_TOOLS_THRESHOLD) return null;

  per.sort((a, b) => b.tokens - a.tokens);
  const details = per.slice(0, 5).map((s) => `${s.name}: ~${s.tokens.toLocaleString()} tokens`);
  if (per.length > 5) details.push(`(${per.length - 5} more servers)`);

  return {
    type: "mcp_tools",
    severity: "warning",
    message: `Large MCP tools context (~${totalTokens.toLocaleString()} tokens estimated > ${MCP_TOOLS_THRESHOLD.toLocaleString()})`,
    details,
    currentValue: totalTokens,
    threshold: MCP_TOOLS_THRESHOLD,
  };
}

// ── Unreachable permission rules ──────────────────────────────────────────

export type ShadowType = "deny" | "ask" | "order";

export interface ShadowedRule {
  rule: ParsedRule;
  shadowedBy: ParsedRule;
  shadowType: ShadowType;
  reason: string;
  fix: string;
}

const PRECEDENCE: Record<ParsedRule["behavior"], number> = { deny: 0, ask: 1, allow: 2 };

export function formatRule(rule: ParsedRule): string {
  return rule.ruleContent !== undefined ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

/** Does rule `s` match every input `r` matches? Tool-wide rules cover any
 *  content for their tool; specific rules cover by exact match, glob,
 *  shell-prefix/wildcard match, or plain substring. */
export function rulesCover(s: ParsedRule, r: ParsedRule): boolean {
  if (s.toolName !== "*" && s.toolName.toLowerCase() !== r.toolName.toLowerCase()) {
    return false;
  }
  if (s.ruleContent === undefined) return true;
  if (r.ruleContent === undefined) return false;
  if (s.ruleContent === r.ruleContent) return true;
  if (matchGlob(s.ruleContent, r.ruleContent)) return true;
  if (matchShellCommand(s.ruleContent, r.ruleContent)) return true;
  if (matchWildcardPattern(s.ruleContent, r.ruleContent)) return true;
  return r.ruleContent.includes(s.ruleContent);
}

/**
 * Detect unreachable permission rules:
 * - deny > ask > allow precedence: a rule of a higher-precedence class that
 *   covers all of a specific rule's matches shadows it (tool-wide conflicts
 *   between same-class... see below);
 * - first match wins within a class: a later rule fully covered by an
 *   earlier same-class rule is never selected.
 * Tool-wide rules are only shadowable within their own class (a tool-wide
 * allow next to a tool-wide deny is a deliberate conflict, not a shadow).
 */
export function detectShadowedRules(rules: readonly ParsedRule[]): ShadowedRule[] {
  const out: ShadowedRule[] = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    let shadowed: { by: ParsedRule; type: ShadowType } | null = null;

    for (let j = 0; j < rules.length; j++) {
      if (i === j) continue;
      const s = rules[j]!;
      if (!rulesCover(s, r)) continue;

      const sPrec = PRECEDENCE[s.behavior];
      const rPrec = PRECEDENCE[r.behavior];
      if (sPrec < rPrec) {
        // Higher-precedence class (deny/ask) beats the rule's own class —
        // only when the shadowed rule is specific (reference behavior).
        if (r.ruleContent === undefined) continue;
        const type: ShadowType = s.behavior === "deny" ? "deny" : "ask";
        if (!shadowed || PRECEDENCE[shadowed.by.behavior] > sPrec) {
          shadowed = { by: s, type };
        }
      } else if (sPrec === rPrec && j < i && !shadowed) {
        // Earlier same-class rule covers this one — first match wins.
        shadowed = { by: s, type: "order" };
      }
    }

    if (shadowed) {
      const by = shadowed.by;
      const reason =
        shadowed.type === "deny"
          ? `Blocked by "${by.toolName}" deny rule (deny takes precedence)`
          : shadowed.type === "ask"
            ? `Shadowed by "${by.toolName}" ask rule (always prompts first)`
            : `Shadowed by earlier "${formatRule(by)}" ${by.behavior} rule (first match wins)`;
      out.push({
        rule: r,
        shadowedBy: by,
        shadowType: shadowed.type,
        reason,
        fix: `Remove the "${by.toolName}" ${by.behavior} rule, or remove this ${r.behavior} rule`,
      });
    }
  }
  return out;
}

export function checkUnreachablePermissionRules(
  permissions: PersistedSettings["permissions"] = loadSettings().permissions,
): ContextWarning | null {
  const shadowed = detectShadowedRules(parsePermissionSettings(permissions ?? {}));
  if (shadowed.length === 0) return null;

  const details = shadowed.flatMap((s) => [
    `${formatRule(s.rule)} (${s.rule.behavior}): ${s.reason}`,
    `  Fix: ${s.fix}`,
  ]);

  return {
    type: "unreachable_rules",
    severity: "warning",
    message: `${shadowed.length} unreachable permission ${shadowed.length === 1 ? "rule" : "rules"} detected`,
    details,
    currentValue: shadowed.length,
    threshold: 0,
  };
}

// ── Agent parse errors ────────────────────────────────────────────────────

const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function frontmatterName(header: string): string | null {
  for (const line of header.split("\n")) {
    const m = line.match(/^name:\s*(.*)$/);
    if (m && m[1]) return m[1]!.trim();
  }
  return null;
}

/** Re-scan the agent dirs the loader skips silently and collect per-file
 *  parse failures (path + error). Mirrors agentDiscovery's acceptance
 *  rules: readable file, name matching [A-Za-z0-9][A-Za-z0-9_-]*. */
export function collectAgentParseErrors(cwd: string = process.cwd()): FileError[] {
  const errors: FileError[] = [];
  const dirs = [join(cwd, ".claude", "agents"), join(homedir(), ".claude", "agents")];
  const seen = new Set<string>();

  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // dir missing — nothing to report
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const path = join(dir, entry);
      if (seen.has(path)) continue;
      seen.add(path);

      let raw = "";
      try {
        raw = readFileSync(path, "utf-8");
      } catch (e) {
        errors.push({ path, error: `unreadable: ${(e as Error).message}` });
        continue;
      }
      const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
      const name = (m ? frontmatterName(m[1]!) : null) ?? entry.slice(0, -3);
      if (!AGENT_NAME_RE.test(name)) {
        errors.push({
          path,
          error: `invalid agent name "${name}" — must match [A-Za-z0-9][A-Za-z0-9_-]*`,
        });
      }
    }
  }
  return errors;
}

// ── Plugin errors ──────────────────────────────────────────────────────────

/** Scan plugin manifests the loader swallows and collect parse failures.
 *  Mirrors pluginService's directory layout and manifest precedence. */
export function collectPluginErrors(): FileError[] {
  const errors: FileError[] = [];
  const dataDir = process.env.DEEPSEEK_CODE_DATA_DIR?.trim() || join(homedir(), ".deepseek-code");
  const pluginsDir = join(dataDir, "plugins");

  let names: string[] = [];
  try {
    names = readdirSync(pluginsDir);
  } catch {
    return errors; // no plugins installed
  }

  for (const name of names) {
    const pluginDir = join(pluginsDir, name);
    const manifestPath = join(pluginDir, "manifest.json");
    let manifestBroken = false;
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown;
        if (
          !manifest ||
          typeof manifest !== "object" ||
          typeof (manifest as { name?: unknown }).name !== "string" ||
          !(manifest as { name?: string }).name
        ) {
          errors.push({ path: manifestPath, error: 'manifest missing required "name" string' });
        }
      } catch (e) {
        manifestBroken = true;
        errors.push({ path: manifestPath, error: `invalid JSON: ${(e as Error).message}` });
      }
    }
    // pluginService only falls through to .claude-plugin when manifest.json
    // is absent or failed — mirror that so we don't double-report.
    const ccManifest = join(pluginDir, ".claude-plugin", "plugin.json");
    if (!existsSync(manifestPath) || manifestBroken) {
      if (existsSync(ccManifest)) {
        try {
          const cc = JSON.parse(readFileSync(ccManifest, "utf-8")) as unknown;
          if (
            !cc ||
            typeof cc !== "object" ||
            typeof (cc as { name?: unknown }).name !== "string" ||
            !(cc as { name?: string }).name
          ) {
            errors.push({ path: ccManifest, error: 'plugin.json missing required "name" string' });
          }
        } catch (e) {
          errors.push({ path: ccManifest, error: `invalid JSON: ${(e as Error).message}` });
        }
      }
    }
  }
  return errors;
}

// ── MCP config parsing warnings ────────────────────────────────────────────

/** Config lookup paths mirroring utils/config.ts (legacy .zcode paths
 *  included so backwards compatibility stays visible in doctor). */
export function defaultConfigPaths(cwd: string = process.cwd()): string[] {
  const home = homedir();
  return [
    join(cwd, ".deepseek-code.json"),
    join(home, ".config", "deepseek-code", "config.json"),
    join(home, ".deepseek-code.json"),
    join(cwd, ".zcode.json"),
    join(home, ".config", "z-code", "config.json"),
    join(home, ".zcode.json"),
  ];
}

/** Parse errors in config files and their mcpServers blocks — loadConfig
 *  swallows these silently, so doctor re-reads the files itself. */
export function collectMcpParsingWarnings(paths: readonly string[] = defaultConfigPaths()): FileError[] {
  const warnings: FileError[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (e) {
      warnings.push({ path, error: `invalid JSON: ${(e as Error).message}` });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const mcp = (parsed as Record<string, unknown>).mcpServers;
    if (mcp === undefined) continue;
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
      warnings.push({ path, error: 'mcpServers must be an object of server-name → config entries' });
      continue;
    }
    for (const [serverName, srv] of Object.entries(mcp as Record<string, unknown>)) {
      if (!srv || typeof srv !== "object" || Array.isArray(srv)) {
        warnings.push({ path, error: `mcpServers.${serverName}: must be an object with a "command" string` });
        continue;
      }
      const s = srv as Record<string, unknown>;
      if (typeof s.command !== "string" || !s.command) {
        warnings.push({ path, error: `mcpServers.${serverName}: missing required "command" string` });
      }
    }
  }
  return warnings;
}

// ── Invalid settings validation ────────────────────────────────────────────

const EFFORT_LEVELS = new Set(["off", "low", "medium", "high", "xhigh", "max"]);
const THEME_MODES = new Set(["dark", "light", "auto"]);
const HOOK_EVENTS = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "Notification"]);
const KNOWN_KEYS = new Set([
  "apiKey", "model", "baseURL", "provider", "defaultAgent", "thinkingMode",
  "effort", "themeMode", "onboarded", "lastSessionHash", "schemaVersion",
  "includeCoAuthoredBy", "cleanupPeriodDays", "spinnerTipsEnabled", "verbose",
  "outputStyle", "env", "permissions", "hooks", "statusLine", "copyFullResponse", "lsp",
]);

const STRING_KEYS = [
  "apiKey", "model", "baseURL", "provider", "defaultAgent", "thinkingMode",
  "lastSessionHash", "outputStyle",
] as const;
const BOOLEAN_KEYS = [
  "onboarded", "includeCoAuthoredBy", "spinnerTipsEnabled", "verbose", "copyFullResponse",
] as const;

/** Type/range checks over the runtime settings object (settings.json is
 *  hand-editable, so nothing here trusts the TS types). */
export function validateSettings(settings: Record<string, unknown>): SettingsError[] {
  const errors: SettingsError[] = [];
  const add = (key: string, message: string) => errors.push({ key, message });

  for (const key of Object.keys(settings)) {
    if (!KNOWN_KEYS.has(key)) add(key, "unknown setting key");
  }
  for (const key of STRING_KEYS) {
    if (settings[key] !== undefined && typeof settings[key] !== "string") {
      add(key, "expected a string");
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (settings[key] !== undefined && typeof settings[key] !== "boolean") {
      add(key, "expected a boolean");
    }
  }
  if (settings.effort !== undefined && !EFFORT_LEVELS.has(String(settings.effort))) {
    add("effort", `invalid value "${String(settings.effort)}" (expected off|low|medium|high|xhigh|max)`);
  }
  if (settings.themeMode !== undefined && !THEME_MODES.has(String(settings.themeMode))) {
    add("themeMode", `invalid value "${String(settings.themeMode)}" (expected dark|light|auto)`);
  }
  if (
    settings.cleanupPeriodDays !== undefined &&
    (typeof settings.cleanupPeriodDays !== "number" ||
      !Number.isInteger(settings.cleanupPeriodDays) ||
      settings.cleanupPeriodDays < 1 ||
      settings.cleanupPeriodDays > 365)
  ) {
    add("cleanupPeriodDays", "expected an integer between 1 and 365");
  }
  if (settings.schemaVersion !== undefined && typeof settings.schemaVersion !== "number") {
    add("schemaVersion", "expected a number");
  }
  if (settings.env !== undefined) {
    if (typeof settings.env !== "object" || Array.isArray(settings.env)) {
      add("env", "expected an object of string values");
    } else {
      for (const [k, v] of Object.entries(settings.env as Record<string, unknown>)) {
        if (typeof v !== "string") add(`env.${k}`, "expected a string");
      }
    }
  }
  if (settings.permissions !== undefined) {
    const perms = settings.permissions;
    if (typeof perms !== "object" || Array.isArray(perms)) {
      add("permissions", "expected an object with allow/deny/ask arrays");
    } else {
      for (const kind of ["allow", "deny", "ask"] as const) {
        const list = (perms as Record<string, unknown>)[kind];
        if (
          list !== undefined &&
          (!Array.isArray(list) || list.some((r) => typeof r !== "string"))
        ) {
          add(`permissions.${kind}`, "expected an array of rule strings");
        }
      }
    }
  }
  if (settings.hooks !== undefined) {
    const hooks = settings.hooks;
    if (typeof hooks !== "object" || Array.isArray(hooks)) {
      add("hooks", "expected an object of hook-event groups");
    } else {
      for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
        if (!HOOK_EVENTS.has(event)) {
          add(`hooks.${event}`, "unknown hook event");
          continue;
        }
        if (!Array.isArray(groups)) {
          add(`hooks.${event}`, "expected an array of hook groups");
          continue;
        }
        for (let g = 0; g < groups.length; g++) {
          const group = groups[g] as Record<string, unknown>;
          if (!group || typeof group !== "object") {
            add(`hooks.${event}[${g}]`, "expected a hook group object");
            continue;
          }
          const hookList = group.hooks;
          if (hookList !== undefined && Array.isArray(hookList)) {
            for (let h = 0; h < hookList.length; h++) {
              const hook = hookList[h] as Record<string, unknown>;
              if (!hook || typeof hook !== "object" || typeof hook.type !== "string") {
                add(`hooks.${event}[${g}].hooks[${h}]`, "expected a hook with a \"type\" string");
              }
            }
          }
        }
      }
    }
  }
  if (settings.statusLine !== undefined) {
    const sl = settings.statusLine;
    if (typeof sl !== "object" || Array.isArray(sl)) {
      add("statusLine", "expected an object");
    } else {
      const obj = sl as Record<string, unknown>;
      if (obj.type !== "command") add("statusLine.type", "only \"command\" status lines are supported");
      if (typeof obj.command !== "string" || !obj.command) {
        add("statusLine.command", "expected a non-empty command string");
      }
      if (obj.padding !== undefined && (typeof obj.padding !== "number" || obj.padding < 0)) {
        add("statusLine.padding", "expected a non-negative number");
      }
    }
  }
  if (settings.lsp !== undefined && (typeof settings.lsp !== "object" || Array.isArray(settings.lsp))) {
    add("lsp", "expected an object");
  }

  return errors;
}

// ── Env-var bounds validation ──────────────────────────────────────────────

export interface EnvVarValidation {
  name: string;
  status: "valid" | "capped" | "invalid";
  effective: number;
  message?: string;
}

export interface EnvVarSpec {
  name: string;
  defaultValue: number;
  upperLimit: number;
}

/** The port's own *_MAX_* knobs with sane upper bounds. */
export const ENV_VAR_SPECS: EnvVarSpec[] = [
  { name: "DEEPSEEK_CODE_FILE_READ_MAX_OUTPUT_TOKENS", defaultValue: 25_000, upperLimit: 250_000 },
  { name: "DEEPSEEK_CODE_FILE_READ_MAX_SIZE_BYTES", defaultValue: 256 * 1024, upperLimit: 10_000_000 },
  { name: "DEEPSEEK_MAX_STEPS", defaultValue: 25, upperLimit: 200 },
];

export function validateBoundedIntEnvVar(
  name: string,
  value: string | undefined,
  defaultValue: number,
  upperLimit: number,
): EnvVarValidation {
  if (value === undefined || value === "") {
    return { name, effective: defaultValue, status: "valid" };
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return {
      name,
      effective: defaultValue,
      status: "invalid",
      message: `Invalid value "${value}" (using default: ${defaultValue})`,
    };
  }
  if (parsed > upperLimit) {
    return {
      name,
      effective: upperLimit,
      status: "capped",
      message: `Capped from ${parsed} to ${upperLimit}`,
    };
  }
  return { name, effective: parsed, status: "valid" };
}

export function validateEnvVars(env: Record<string, string | undefined> = process.env): EnvVarValidation[] {
  return ENV_VAR_SPECS.map((spec) =>
    validateBoundedIntEnvVar(spec.name, env[spec.name], spec.defaultValue, spec.upperLimit),
  ).filter((v) => v.status !== "valid");
}

// ── Search (rg) health ─────────────────────────────────────────────────────

export interface RipgrepCheck {
  ok: boolean;
  version: string;
  detail: string;
}

/** The port shells out to system `rg` (no bundled binary), so this reports
 *  system rg presence/version for the Grep tool. */
export function checkRipgrep(): RipgrepCheck {
  const missing = { ok: false, version: "", detail: "not found on PATH — the Grep tool requires rg" };
  try {
    const proc = Bun.spawnSync(["rg", "--version"], { stdio: ["ignore", "pipe", "ignore"] });
    const out = proc.stdout?.toString() ?? "";
    const firstLine = out.split("\n")[0]?.trim() ?? "";
    if (proc.exitCode === 0 && firstLine) {
      return { ok: true, version: firstLine, detail: `system rg — ${firstLine}` };
    }
    return missing;
  } catch {
    return missing;
  }
}

// ── Aggregate ──────────────────────────────────────────────────────────────

export interface DoctorDiagnostics {
  contextWarnings: ContextWarnings;
  agentParseErrors: FileError[];
  pluginErrors: FileError[];
  mcpParsingWarnings: FileError[];
  invalidSettings: SettingsError[];
  envVarErrors: EnvVarValidation[];
  ripgrep: RipgrepCheck;
}

/** Everything the /doctor view renders below its check rows. */
export function runDoctorChecks(): DoctorDiagnostics {
  return {
    contextWarnings: {
      claudeMdWarning: checkClaudeMdWarnings(),
      agentWarning: checkAgentDescriptionWarnings(),
      mcpWarning: checkMcpContextWarnings(),
      unreachableRulesWarning: checkUnreachablePermissionRules(),
    },
    agentParseErrors: collectAgentParseErrors(),
    pluginErrors: collectPluginErrors(),
    mcpParsingWarnings: collectMcpParsingWarnings(),
    invalidSettings: validateSettings(loadSettings() as unknown as Record<string, unknown>),
    envVarErrors: validateEnvVars(),
    ripgrep: checkRipgrep(),
  };
}
