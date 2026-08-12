// skillService — model-invokable skills
//
// Discovers SKILL.md files from three sources, in precedence order:
//   1. project  — <cwd>/.claude/skills/<name>/SKILL.md
//   2. user     — ~/.claude/skills/<name>/SKILL.md
//   3. bundled  — src/skills/bundled/<name>/SKILL.md (ships with the app)
//
// Each skill lives in its own directory containing a SKILL.md file with
// optional YAML-ish frontmatter:
//
//   ---
//   name: code-review
//   description: Systematic review checklist
//   ---
//
//   <markdown body — the instructions the model follows>
//
// Frontmatter parsing is minimal and tolerant: `name` falls back to the
// directory name, `description` falls back to the first body line, and a
// missing frontmatter block entirely is fine. Results are cached for the
// process lifetime; clearSkillsCache() resets them.
//
// The SkillTool embeds the listing (name + description) in its DESCRIPTION so
// the model can discover skills autonomously; invoking SkillTool({name})
// returns the full body. Discovery reads are cheap and local, so the cache
// loader is synchronous — this also lets the tool description be built
// synchronously at module load (toolsToBindingFormat reads `description` at
// binding time and cannot await).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SkillSource = "project" | "user" | "bundled" | "plugin";

export interface SkillInfo {
  name: string;
  description: string;
  source: SkillSource;
  path: string;
}

export interface SkillContent extends SkillInfo {
  /** Full SKILL.md body with frontmatter stripped. */
  content: string;
}

interface LoadedSkill extends SkillContent {}

// ─── Frontmatter parsing ────────────────────────────────────────────────────

export interface ParsedSkillMarkdown {
  name: string | undefined;
  description: string | undefined;
  body: string;
}

/**
 * Parse minimal SKILL.md frontmatter: `key: value` lines between `---` fences
 * at the top of the file. Tolerates missing frontmatter, unquoted/quoted
 * values, and `\r\n` line endings. On any malformation, the whole file is
 * treated as body and the caller falls back to directory-name/body-line.
 */
export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const lines = raw.split(/\r?\n/);
  if (!lines[0] || lines[0].trim() !== "---") {
    return { name: undefined, description: undefined, body: raw };
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
    // Unterminated frontmatter — treat the whole file as body.
    return { name: undefined, description: undefined, body: raw };
  }
  const body = lines
    .slice(i + 1)
    .join("\n")
    .replace(/^\n+/, "");
  return { name: meta["name"], description: meta["description"], body };
}

/** First non-empty, non-heading body line — the description fallback. */
function fallbackDescription(body: string): string {
  const line = body.split(/\r?\n/).find((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith("#");
  });
  if (!line) return "";
  const trimmed = line.trim().replace(/^[-*+]\s+/, "");
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Locate the bundled skills directory. `import.meta.dir` is src/skills in dev
 * (`bun run src/index.tsx`); the cwd-relative fallback covers other layouts
 * (e.g. running from the repo root after a bundle that did not copy assets).
 */
function bundledSkillsDir(): string {
  const primary = join(import.meta.dir, "bundled");
  const fallback = join(process.cwd(), "src", "skills", "bundled");
  return existsSync(primary) ? primary : existsSync(fallback) ? fallback : primary;
}

/** Load all `<dir>/<name>/SKILL.md` entries. Missing/unreadable dirs are skipped. */
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
    if (!entry.isDirectory()) continue; // only skill-name/SKILL.md directories
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let raw: string;
    try {
      raw = readFileSync(skillFile, "utf8");
    } catch {
      continue; // unreadable skill — skip rather than crash
    }
    const { name, description, body } = parseSkillMarkdown(raw);
    out.push({
      name: name || entry.name,
      description: description || fallbackDescription(body),
      content: body,
      source,
      path: skillFile,
    });
  }
  return out;
}

let cached: LoadedSkill[] | null = null;

/** Load once per process. Precedence project > user > bundled > plugin
 *  (first-wins by name). Plugin skills come from installed plugins
 *  (including Claude Code marketplace plugins — retro-compat), so the model
 *  can discover marketplace skills through the Skill tool too. */
function loadAll(): LoadedSkill[] {
  const byName = new Map<string, LoadedSkill>();
  const sources: Array<[string, SkillSource]> = [
    [join(process.cwd(), ".claude", "skills"), "project"],
    [join(homedir(), ".claude", "skills"), "user"],
    [bundledSkillsDir(), "bundled"],
  ];
  for (const [dir, source] of sources) {
    for (const skill of loadSkillsFromDir(dir, source)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  // Plugin skills (enabled plugins only) — lowest precedence.
  try {
    const { loadInstalledPlugins } = require("../services/pluginService.js") as {
      loadInstalledPlugins: () => Array<{
        name: string;
        enabled: boolean;
        manifest: { skills?: Array<{ name: string; description: string; prompt: string }> };
      }>;
    };
    for (const plugin of loadInstalledPlugins()) {
      if (!plugin.enabled) continue;
      for (const skill of plugin.manifest.skills ?? []) {
        if (!byName.has(skill.name)) {
          byName.set(skill.name, {
            name: skill.name,
            description: skill.description,
            source: "plugin",
            path: `plugin:${plugin.name}/${skill.name}`,
            content: skill.prompt,
          });
        }
      }
    }
  } catch {
    // plugin service unavailable — degrade to file-based skills only
  }
  return [...byName.values()];
}

function ensureLoaded(): LoadedSkill[] {
  if (cached === null) cached = loadAll();
  return cached;
}

function toSkillInfo(s: LoadedSkill): SkillInfo {
  return { name: s.name, description: s.description, source: s.source, path: s.path };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** All discovered skills (project > user > bundled precedence), sorted by name. */
export function listSkills(): SkillInfo[] {
  return ensureLoaded().map(toSkillInfo).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Look up one skill by name. Tolerates a leading "/" (slash-command style)
 * and case differences. Returns the full instructions with frontmatter
 * stripped, or null when no skill matches.
 */
export function getSkill(name: string): SkillContent | null {
  const trimmed = name.trim().replace(/^\//, "");
  if (!trimmed) return null;
  const match = ensureLoaded().find(
    (s) => s.name.toLowerCase() === trimmed.toLowerCase(),
  );
  return match ? { ...match } : null;
}

/**
 * Build the SkillTool DESCRIPTION text: the given guidance header plus the
 * embedded listing of available skills (name + description). The listing is
 * what lets the model discover and invoke skills autonomously.
 */
export function buildSkillToolDescription(header: string): string {
  const skills = listSkills();
  const listing =
    skills.length === 0
      ? "  (no skills available)"
      : skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `${header}\n\nAvailable skills:\n${listing}`;
}

/** Reset the discovery cache (e.g. after installing a new project skill). */
export function clearSkillsCache(): void {
  cached = null;
}
