import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Custom-agent discovery — the Claude Code `.claude/agents/*.md` convention:
 * markdown files with YAML frontmatter (name, description, tools, model,
 * color) and a prompt body. Project dir wins over the user dir on name
 * collisions, mirroring skill discovery precedence.
 */

export interface DiscoveredAgentDef {
  name: string;
  description: string;
  /** Prompt body after the frontmatter — becomes the agent's systemPrompt. */
  prompt: string;
  model?: string;
  /** Tool names requested in frontmatter (filtered to known tools). */
  tools: string[];
  color?: string;
  sourcePath: string;
}

/** Tool names that grant write/execute access when listed in an agent's
 *  frontmatter. Everything else defaults to read-only. */
const WRITE_TOOL_NAMES = new Set([
  "Write", "Edit", "NotebookEdit", "FileWrite", "FileEdit",
  "EnterPlanMode", "ExitPlanMode",
]);

const EXECUTE_TOOL_NAMES = new Set([
  "Bash", "PowerShell", "REPL",
]);

/** Known tool names — unknown frontmatter entries are dropped. */
const KNOWN_TOOL_NAMES = new Set([
  "Read", "Write", "Edit", "NotebookEdit", "FileWrite", "FileEdit",
  "Bash", "PowerShell", "REPL",
  "Glob", "Grep", "LS", "LSP",
  "WebFetch", "WebSearch",
  "TodoWrite", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList",
  "TaskOutput", "TaskStop",
  "Agent", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
  "EnterWorktree", "ExitWorktree",
  "Skill", "Brief", "Sleep", "ScheduleCron", "Config", "ToolSearch",
]);

export function toolGrantsWrite(tools: readonly string[]): boolean {
  return tools.some((t) => WRITE_TOOL_NAMES.has(t));
}

export function toolGrantsExecute(tools: readonly string[]): boolean {
  return tools.some((t) => EXECUTE_TOOL_NAMES.has(t));
}

function agentDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const project = join(cwd, ".claude", "agents");
  const user = join(homedir(), ".claude", "agents");
  if (existsSync(project)) dirs.push(project);
  if (existsSync(user) && user !== project) dirs.push(user);
  return dirs;
}

/** YAML-lite frontmatter parser: `key: value` pairs plus `- item` list
 *  entries for `tools`. Handles `description: |` block scalars. */
interface Frontmatter {
  name?: string;
  description?: string;
  tools: string[];
  model?: string;
  color?: string;
}

function parseFrontmatter(header: string): Frontmatter {
  const fm: Frontmatter = { tools: [] };
  const lines = header.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith("-")) {
      const item = line.trim().slice(1).trim();
      if (item) fm.tools.push(item);
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    if (value === "|") {
      // Block scalar: consume indented lines until a dedent.
      const parts: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1] === "" || /^\s+/.test(lines[i + 1]!))) {
        i++;
        if (lines[i] === "") continue;
        parts.push(lines[i]!.replace(/^\s+/, ""));
      }
      value = parts.join("\n").trim();
    }
    if (key === "name") fm.name = value;
    else if (key === "description") fm.description = value;
    else if (key === "model") fm.model = value;
    else if (key === "color") fm.color = value;
    else if (key === "tools") {
      // Inline list: tools: Read, Grep or tools: [Read, Grep]
      const items = value.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      fm.tools.push(...items);
    }
  }
  return fm;
}

function parseAgentFile(raw: string, sourcePath: string, fallbackName: string): DiscoveredAgentDef | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const fm = match ? parseFrontmatter(match[1]!) : { tools: [] as string[] };
  const body = match ? match[2]! : raw;
  const name = (fm.name ?? fallbackName).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return null;
  return {
    name,
    description: fm.description ?? "",
    prompt: body.trim(),
    model: fm.model,
    tools: fm.tools.filter((t) => KNOWN_TOOL_NAMES.has(t)),
    color: fm.color,
    sourcePath,
  };
}

/** Discover custom agents: project `.claude/agents/*.md` first, then user
 *  `~/.claude/agents/*.md`; project wins on name collisions. */
export function listDiscoveredAgents(cwd: string = process.cwd()): DiscoveredAgentDef[] {
  const byName = new Map<string, DiscoveredAgentDef>();
  for (const dir of agentDirs(cwd)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const path = join(dir, entry);
      let raw = "";
      try {
        raw = readFileSync(path, "utf-8");
      } catch {
        continue;
      }
      const fallbackName = entry.slice(0, -3);
      const def = parseAgentFile(raw, path, fallbackName);
      if (def && !byName.has(def.name)) byName.set(def.name, def);
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getDiscoveredAgent(name: string, cwd: string = process.cwd()): DiscoveredAgentDef | undefined {
  return listDiscoveredAgents(cwd).find((d) => d.name === name);
}
