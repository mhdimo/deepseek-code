




























import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "../utils/limits.js";
import type { CommandDefinition } from "../services/commands/commandRegistry.js";

export type SkillSource = "project" | "user" | "bundled" | "plugin";

export interface SkillInfo {
  name: string;
  description: string;
  source: SkillSource;
  path: string;
  /** `when_to_use` frontmatter, when present (feeds the token estimate). */
  whenToUse?: string;
  /** Estimated prompt size in tokens (~4 chars/token), shown in /skills. */
  estimatedTokens: number;
  /** Manifest name of the owning plugin (plugin-sourced skills only). */
  pluginName?: string;
}

export interface SkillContent extends SkillInfo {

  content: string;
}

interface LoadedSkill extends SkillContent {}



export interface ParsedSkillMarkdown {
  name: string | undefined;
  description: string | undefined;
  whenToUse: string | undefined;
  body: string;
}


export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const lines = raw.split(/\r?\n/);
  if (!lines[0] || lines[0].trim() !== "---") {
    return { name: undefined, description: undefined, whenToUse: undefined, body: raw };
  }
  const meta: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (line === "---") break;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) meta[m[1]!.toLowerCase()] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
  if (i >= lines.length) {

    return { name: undefined, description: undefined, whenToUse: undefined, body: raw };
  }
  const body = lines
    .slice(i + 1)
    .join("\n")
    .replace(/^\n+/, "");
  return {
    name: meta["name"],
    description: meta["description"],
    whenToUse: meta["when_to_use"],
    body,
  };
}

/** ~4 chars/token — same rough estimate the /skills menu shows per skill. */
export function estimateSkillTokens(
  name: string | undefined,
  description: string | undefined,
  whenToUse: string | undefined,
): number {
  return estimateTokens([name, description, whenToUse].filter(Boolean).join(" "));
}

/** On-disk directory that `source` skills are discovered from. Project is
 *  cwd-relative (reference `getSkillsPath` semantics); user/bundled absolute. */
export function getSkillSourceDir(source: SkillSource): string {
  switch (source) {
    case "project":
      return join(".claude", "skills");
    case "user":
      return join(homedir(), ".claude", "skills");
    case "bundled":
      return bundledSkillsDir();
    default:
      return "plugin";
  }
}


function fallbackDescription(body: string): string {
  const line = body.split(/\r?\n/).find((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith("#");
  });
  if (!line) return "";
  const trimmed = line.trim().replace(/^[-*+]\s+/, "");
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}




function bundledSkillsDir(): string {
  const primary = join(import.meta.dir, "bundled");
  const fallback = join(process.cwd(), "src", "skills", "bundled");
  return existsSync(primary) ? primary : existsSync(fallback) ? fallback : primary;
}


function loadSkillsFromDir(dir: string, source: SkillSource): LoadedSkill[] {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LoadedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; 
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let raw: string;
    try {
      raw = readFileSync(skillFile, "utf8");
    } catch {
      continue; 
    }
    const { name, description, whenToUse, body } = parseSkillMarkdown(raw);
    const resolvedName = name || entry.name;
    const resolvedDescription = description || fallbackDescription(body);
    out.push({
      name: resolvedName,
      description: resolvedDescription,
      whenToUse,
      estimatedTokens: estimateSkillTokens(resolvedName, resolvedDescription, whenToUse),
      content: body,
      source,
      path: skillFile,
    });
  }
  return out;
}

let cached: LoadedSkill[] | null = null;


function loadAll(): LoadedSkill[] {
  const byName = new Map<string, LoadedSkill>();
  for (const source of ["project", "user", "bundled"] as const) {
    for (const skill of loadSkillsFromDir(getSkillSourceDir(source), source)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }

  try {
    const { loadInstalledPlugins } = require("../services/pluginService.js") as {
      loadInstalledPlugins: () => Array<{
        name: string;
        enabled: boolean;
        manifest: { name: string; skills?: Array<{ name: string; description: string; prompt: string }> };
      }>;
    };
    for (const plugin of loadInstalledPlugins()) {
      if (!plugin.enabled) continue;
      for (const skill of plugin.manifest.skills ?? []) {
        if (!byName.has(skill.name)) {
          byName.set(skill.name, {
            name: skill.name,
            description: skill.description,
            estimatedTokens: estimateSkillTokens(skill.name, skill.description, undefined),
            pluginName: plugin.manifest.name,
            source: "plugin",
            path: `plugin:${plugin.name}/${skill.name}`,
            content: skill.prompt,
          });
        }
      }
    }
  } catch {

  }
  return [...byName.values()];
}

function ensureLoaded(): LoadedSkill[] {
  if (cached === null) cached = loadAll();
  return cached;
}

function toSkillInfo(s: LoadedSkill): SkillInfo {
  return {
    name: s.name,
    description: s.description,
    whenToUse: s.whenToUse,
    estimatedTokens: s.estimatedTokens,
    pluginName: s.pluginName,
    source: s.source,
    path: s.path,
  };
}




export function listSkills(): SkillInfo[] {
  return ensureLoaded().map(toSkillInfo).sort((a, b) => a.name.localeCompare(b.name));
}


export function getSkill(name: string): SkillContent | null {
  const trimmed = name.trim().replace(/^\//, "");
  if (!trimmed) return null;
  const match = ensureLoaded().find(
    (s) => s.name.toLowerCase() === trimmed.toLowerCase(),
  );
  return match ? { ...match } : null;
}


/**
 * A skill as the command picker sees it — the same shape a custom command or a
 * plugin command has, so it lands in the same list. The description is the
 * SKILL.md frontmatter's and nothing more: the picker is a list, not a preview.
 */
export function toSkillCommand(skill: SkillInfo): CommandDefinition {
  return {
    name: skill.name.trim().replace(/^\/+/, "").toLowerCase(),
    description: skill.description || `Skill: ${skill.name}`,
    usage: [`/${skill.name} `],
    category: "skill",
    acceptsArgs: true,
    executionKey: "skill",
  };
}

/**
 * The prompt a skill invoked as a slash command sends.
 *
 * Same substitution a custom command gets, because a SKILL.md author writes
 * `$ARGUMENTS` expecting exactly that, and the same append when they did not —
 * the arguments have to reach the model either way, and dropping them silently
 * is the one outcome that would look like the skill ignoring the request.
 */
export function renderSkillPrompt(skill: SkillContent, args: readonly string[]): string {
  const argString = args.join(" ");
  // Templated means the body said where the arguments go — `$ARGUMENTS`, or a
  // positional `$1`/`$2`. Appending them after a body that already placed them
  // would send the same request twice.
  const templated = /\$ARGUMENTS|\$\d+/.test(skill.content);
  let out = skill.content.split("$ARGUMENTS").join(argString).split("${ARGUMENTS}").join(argString);
  args.forEach((arg, index) => {
    out = out.split(`$${index + 1}`).join(arg).split(`\${${index + 1}}`).join(arg);
  });
  out = out.trim();
  if (!templated && argString) return `${out}\n\nUser request/argument: ${argString}`;
  return out;
}

export function buildSkillToolDescription(header: string): string {
  const skills = listSkills();
  const listing =
    skills.length === 0
      ? "  (no skills available)"
      : skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `${header}\n\nAvailable skills:\n${listing}`;
}


export function clearSkillsCache(): void {
  cached = null;
}
