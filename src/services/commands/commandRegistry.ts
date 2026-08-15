export type CommandCategory =
  | "general"
  | "model"
  | "agent"
  | "session"
  | "project"
  | "mcp"
  | "custom"
  | "plugin";

export interface CommandDefinition {
  /** Canonical name without the leading slash. */
  name: string;
  description: string;
  category: CommandCategory;
  aliases?: readonly string[];
  usage?: readonly string[];
  argumentHint?: string;
  acceptsArgs?: boolean;
  /** The App dispatch key. Built-ins use their canonical name. */
  executionKey: string;
}

export interface ParsedSlashCommand {
  canonicalName: string;
  args: string[];
  rawArgs: string;
  input: string;
}

const command = (
  name: string,
  description: string,
  category: CommandCategory,
  options: Omit<CommandDefinition, "name" | "description" | "category" | "executionKey"> = {},
): CommandDefinition => ({
  name,
  description,
  category,
  executionKey: name,
  ...options,
});

/**
 * The supported local command surface. Keep this list deliberately focused:
 * every entry is backed by a local handler or an existing agent workflow.
 */
export const BUILTIN_COMMANDS: readonly CommandDefinition[] = [
  command("setup", "Quick API key and model setup", "model", {
    aliases: ["login"],
    usage: ["/setup <api-key> [model]"],
    acceptsArgs: true,
  }),
  command("model", "Select or switch the model (interactive picker)", "model", {
    usage: ["/model <name>"],
    acceptsArgs: true,
  }),
  command("models", "Select a model or profile (opens the picker)", "model"),
  command("apikey", "Set the API key for the current provider", "model", {
    aliases: ["key"],
    usage: ["/apikey <key>"],
    acceptsArgs: true,
  }),
  command("baseurl", "Set or clear the custom API endpoint", "model", {
    usage: ["/baseurl <url>", "/baseurl clear"],
    acceptsArgs: true,
  }),
  command("logout", "Clear the saved DeepSeek API key", "model"),

  command("agent", "Switch agent with an interactive picker (code, plan, review)", "agent", {
    usage: ["/agent <name>"],
    acceptsArgs: true,
  }),
  command("plan", "Switch to the plan agent (read-only)", "agent"),
  command("review", "Review uncommitted changes with the review agent", "agent"),
  command("security-review", "Run a security review of uncommitted changes", "agent"),
  command("think", "Toggle extended reasoning", "agent", {
    aliases: ["reason"],
    usage: ["/think off", "/think whale"],
    acceptsArgs: true,
  }),
  command("effort", "Set reasoning effort", "agent", {
    usage: ["/effort [off|low|medium|high|max]"],
    acceptsArgs: true,
  }),
  command("skills", "Browse skills and read their instructions", "agent", {
    usage: ["/skills <name>"],
    acceptsArgs: true,
  }),
  command("tools", "List available tools for the current agent", "agent"),
  command("hooks", "Manage lifecycle hooks (add, toggle, delete)", "agent"),
  command("workflows", "Browse and run multi-phase agent workflows", "agent"),
  command("teams", "Create and manage agent teams with per-teammate colors", "agent"),

  command("init", "Create a project memory file", "project"),
  command("memory", "Open a project memory file in your editor", "project"),
  command("files", "List top-level project files and directories", "project", {
    usage: ["/files [path]"],
    acceptsArgs: true,
  }),
  command("permissions", "Manage permission rules (add, delete)", "project"),
  command("workspace", "Show workspace path and trust status", "project"),
  command("branch", "Show the current git branch", "project"),
  command("env", "Show environment variable configuration", "project"),

  command("sessions", "Browse and resume saved sessions", "session", {
    usage: ["/sessions clear"],
    acceptsArgs: true,
  }),
  command("resume", "Pick a session to resume", "session", {
    usage: ["/resume <hash>"],
    acceptsArgs: true,
  }),
  command("history", "Show conversation history message numbers", "session", {
    aliases: ["messages"],
  }),
  command("rewind", "Pick a message to rewind the conversation to", "session", {
    usage: ["/rewind <number>"],
    acceptsArgs: true,
  }),
  command("search", "Search the conversation", "session", {
    usage: ["/search <query>"],
    acceptsArgs: true,
  }),
  command("export", "Export the conversation to a file", "session", {
    usage: ["/export [markdown|json]"],
    acceptsArgs: true,
  }),
  command("compact", "Summarize the conversation to save context", "session", {
    acceptsArgs: true,
  }),
  command("copy", "Pick an assistant response to copy to the clipboard", "session", {
    usage: ["/copy [message-number]"],
    acceptsArgs: true,
  }),
  command("clear", "Clear conversation history", "session"),

  command("commit", "Create a git commit from changes", "project"),
  command("pr", "Commit, push, and create a GitHub pull request", "project"),
  command("diff", "Show the git diff of current changes", "project"),
  command("doctor", "Run interactive diagnostics (runtime, bindings, network)", "general"),
  command("cost", "Show session token usage and cost", "general"),
  command("usage", "Show usage and activity details", "general"),
  command("stats", "Show session statistics", "general"),

  command("help", "Show help and keybindings", "general", {
    aliases: ["?"],
  }),
  command("shortcuts", "Toggle the keyboard shortcuts panel", "general", {
    aliases: ["keybindings"],
  }),
  command("mcp", "Manage MCP servers (toggle, reconnect)", "mcp", {
    aliases: ["servers"],
    usage: ["/mcp enable <name>", "/mcp disable <name>"],
    acceptsArgs: true,
  }),
  command("queue", "Show or clear queued prompts", "session", {
    usage: ["/queue clear"],
    acceptsArgs: true,
  }),
  command("statusline", "Show or set the custom status line", "general", {
    usage: ["/statusline <command>", "/statusline off"],
    acceptsArgs: true,
  }),
  command("settings", "Open general settings", "general"),
  command("config", "Open configuration settings", "general"),
  command("status", "Show session status and diagnostics", "general"),
  command("theme", "Show or set the color theme", "general", {
    aliases: ["color"],
    usage: ["/theme <setting>"],
    acceptsArgs: true,
  }),
  command("output-style", "Pick an output style (interactive)", "general", {
    usage: ["/output-style <name>"],
    acceptsArgs: true,
  }),
  command("context", "Show context window usage breakdown", "session"),
  command("todos", "Show the agent's todo list", "session"),
  command("bashes", "Browse background tasks — shells, agents, workflows (view output, kill)", "session", {
    aliases: ["tasks"],
  }),
  command("test", "Run the project's basic test suite", "general", {
    usage: ["/test [typecheck|build]"],
    acceptsArgs: true,
  }),
  command("terminal-setup", "Show terminal setup and rendering guidance", "general"),
  command("version", "Show DeepSeek Code and runtime versions", "general"),
  command("plugin", "Manage installed plugins", "plugin", {
    aliases: ["plugins"],
    acceptsArgs: true,
  }),
  command("exit", "Exit DeepSeek Code", "session", {
    aliases: ["quit"],
  }),
] as const;

const normalizeName = (name: string): string => name.trim().replace(/^\/+/, "").toLowerCase();

const commandByName = new Map<string, CommandDefinition>();
const aliasToName = new Map<string, string>();

for (const definition of BUILTIN_COMMANDS) {
  const name = normalizeName(definition.name);
  commandByName.set(name, definition);
  for (const alias of definition.aliases ?? []) {
    aliasToName.set(normalizeName(alias), name);
  }
}

export function resolveCommandName(name: string): string | null {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  if (commandByName.has(normalized)) return normalized;
  return aliasToName.get(normalized) ?? null;
}

function tokenizeArguments(rawArgs: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const character of rawArgs) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const token = match[1] ?? "";
  const rawArgs = match[2] ?? "";
  const canonicalName = resolveCommandName(token) ?? normalizeName(token);
  if (!canonicalName) return null;

  return {
    canonicalName,
    args: tokenizeArguments(rawArgs),
    rawArgs,
    input: trimmed,
  };
}

export function parseSetupArguments(
  parsed: ParsedSlashCommand | null,
): { apiKey: string; model?: string } | null {
  if (!parsed || parsed.canonicalName !== "setup") return null;
  const apiKey = parsed.args[0]?.trim();
  if (!apiKey) return null;
  const model = parsed.args[1]?.trim();
  return model ? { apiKey, model } : { apiKey };
}

function definitionAliases(definition: CommandDefinition): string[] {
  return [definition.name, ...(definition.aliases ?? [])].map(normalizeName);
}

export function filterCommandDefinitions(
  input: string,
  extras: readonly CommandDefinition[] = [],
): CommandDefinition[] {
  const trimmedInput = input.trim();
  if (!trimmedInput.startsWith("/")) return [];
  const query = trimmedInput.toLowerCase().replace(/^\/+/, "");
  const definitions = mergeCommandDefinitions(BUILTIN_COMMANDS, extras);

  return definitions
    .map((definition, index) => {
      const names = definitionAliases(definition);
      let score = 0;
      if (query) {
        const canonical = normalizeName(definition.name);
        if (canonical === query) score = 100;
        else if (names.slice(1).some((name) => name === query)) score = 95;
        else if (canonical.startsWith(query)) score = 90;
        else if (names.slice(1).some((name) => name.startsWith(query))) score = 80;
        else if (canonical.includes(query)) score = 70;
        else if (names.slice(1).some((name) => name.includes(query))) score = 60;
        else if (definition.description.toLowerCase().includes(query)) score = 40;
      }
      return { definition, index, score };
    })
    .filter(({ score }) => !query || score > 0)
    .sort((left, right) => right.score - left.score || left.definition.name.localeCompare(right.definition.name) || left.index - right.index)
    .map(({ definition }) => definition);
}

export function mergeCommandDefinitions(
  ...groups: readonly (readonly CommandDefinition[])[]
): CommandDefinition[] {
  const seen = new Set<string>();
  const merged: CommandDefinition[] = [];

  for (const group of groups) {
    for (const definition of group) {
      const name = normalizeName(definition.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      merged.push({
        ...definition,
        name,
        aliases: definition.aliases?.map(normalizeName),
      });
    }
  }

  return merged;
}

const HELP_GROUP_SPECS: readonly { title: string; names: readonly string[] }[] = [
  {
    title: "Setup & model",
    names: ["setup", "model", "models", "apikey", "baseurl", "logout"],
  },
  {
    title: "Agents & reasoning",
    names: ["agent", "think", "effort", "plan", "review", "security-review", "skills", "tools", "hooks"],
  },
  {
    title: "Project",
    names: ["init", "memory", "files", "permissions", "workspace", "branch", "env"],
  },
  {
    title: "Sessions & history",
    names: ["sessions", "resume", "history", "rewind", "search", "export", "compact", "copy", "clear", "workflows", "teams"],
  },
  {
    title: "Git & diagnostics",
    names: ["commit", "pr", "diff", "doctor", "cost", "usage", "stats"],
  },
  {
    title: "System",
    names: [
      "help",
      "shortcuts",
      "mcp",
      "queue",
      "statusline",
      "settings",
      "config",
      "status",
      "theme",
      "output-style",
      "context",
      "todos",
      "bashes",
      "test",
      "terminal-setup",
      "version",
      "plugin",
      "exit",
    ],
  },
];

export function getHelpGroups(): Array<{ title: string; commands: CommandDefinition[] }> {
  const byName = new Map(BUILTIN_COMMANDS.map((definition) => [definition.name, definition]));
  return HELP_GROUP_SPECS.map(({ title, names }) => ({
    title,
    commands: names.flatMap((name) => {
      const definition = byName.get(name);
      return definition ? [definition] : [];
    }),
  }));
}
