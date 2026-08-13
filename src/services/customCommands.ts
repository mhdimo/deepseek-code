

















import { existsSync, readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";
import type { CommandDef } from "../components/CommandPicker.js";

export interface CustomCommand {
  name: string; 
  source: string; 
  description: string;
  argumentHint?: string;
  body: string; 
}

function replaceAllStr(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}

function parseFrontMatter(raw: string): {
  description?: string;
  argumentHint?: string;
  body: string;
} {
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fm) return { body: raw };
  const yaml = fm[1]!;
  const body = fm[2] ?? "";
  const strip = (s: string | undefined) => s?.trim().replace(/^["']|["']$/g, "");
  const description = strip(yaml.match(/^description:\s*(.+)$/m)?.[1]);
  const argumentHint = strip(yaml.match(/^argument-hint:\s*(.+)$/m)?.[1]);
  return { description, argumentHint, body };
}

function walkMd(dir: string, base: string, out: CustomCommand[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walkMd(full, base, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      
      const stem = relative(base, full)
        .replace(/\.md$/i, "")
        .split(/[\\/]/)
        .join("-");
      let raw = "";
      try {
        raw = readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      const { description, argumentHint, body } = parseFrontMatter(raw);
      out.push({
        name: stem,
        source: full,
        description: description || `Custom command: ${stem}`,
        argumentHint,
        body,
      });
    }
  }
}

export function loadCustomCommands(cwd: string): CustomCommand[] {
  const dirs = [
    join(homedir(), ".deepseek-code", "commands"),
    join(cwd, ".deepseek-code", "commands"),
  ];
  const byName = new Map<string, CustomCommand>();
  for (const d of dirs) {
    const list: CustomCommand[] = [];
    walkMd(d, d, list);
    for (const c of list) byName.set(c.name.toLowerCase(), c); 
  }
  return [...byName.values()];
}


export function renderCommand(cmd: CustomCommand, args: readonly string[]): string {
  const argString = args.join(" ");
  let out = cmd.body;
  out = replaceAllStr(out, "$ARGUMENTS", argString);
  out = replaceAllStr(out, "${ARGUMENTS}", argString);
  args.forEach((a, i) => {
    out = replaceAllStr(out, `$${i + 1}`, a);
    out = replaceAllStr(out, `\${${i + 1}}`, a);
  });
  return out.trim();
}

export function toCommandDefs(cmds: readonly CustomCommand[]): CommandDef[] {
  return cmds
    .filter((c) => !isReservedBuiltin(c.name)) 
    .map((c) => ({
      name: `/${c.name}`,
      description: c.description,
      usage: c.argumentHint ? `/${c.name} ${c.argumentHint}` : `/${c.name} `,
    }));
}


export function isReservedBuiltin(name: string): boolean {
  
  return [
    "help", "shortcuts", "think", "model", "models", "agent", "tools", "mcp",
    "clear", "compact", "sessions", "resume", "commit", "pr", "copy", "diff",
    "history", "rewind", "doctor", "plugin", "plugins", "hooks", "config",
    "status", "stats", "usage", "cost", "settings", "exit", "quit", "add-dir",
  ].includes(name.toLowerCase());
}
