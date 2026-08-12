// Help catalog — the /help content as data.
//
// The command list mirrors the real slash-command switch in
// src/components/App.tsx (handleCommand). If a command is added, removed, or
// renamed there, update this catalog to match. Rendered by
// src/components/HelpView.tsx.

/** One slash command shown in /help. */
export interface HelpCommand {
  /** Command name including the leading slash, e.g. "/model". */
  name: string;
  /** One-line description of what the command does. */
  description: string;
  /** Optional usage lines shown under the description. */
  usage?: string[];
  /** Alternate spellings / aliases, e.g. "/usage" for "/cost". */
  aliases?: string[];
}

/** A titled section of commands in the help output. */
export interface CommandGroup {
  title: string;
  commands: HelpCommand[];
}

/** Intro line shown at the top of the help output. */
export const HELP_INTRO =
  "DeepSeek Code understands your codebase, makes edits with your permission, and executes commands — right from your terminal.";

/** Footer line with a link to further documentation. */
export const HELP_FOOTER = "For more help: https://api-docs.deepseek.com";

/** Keyboard shortcuts section of the help output. */
export const KEYBOARD_SHORTCUTS: ReadonlyArray<{ keys: string; description: string }> = [
  { keys: "↑↓", description: "Navigate command picker (type / first)" },
  { keys: "Tab", description: "Confirm picker selection / autocomplete" },
  { keys: "Shift+Tab", description: "Cycle permission mode (default → accept edits → plan → bypass)" },
  { keys: "Ctrl+O", description: "Toggle transcript mode (expand thinking/tool blocks)" },
  { keys: "Ctrl+E", description: "Toggle Inspect Mode (expand/collapse tool outputs)" },
  { keys: "Ctrl+Q", description: "Clear queued prompts" },
  { keys: "?", description: "Toggle shortcuts panel" },
  { keys: "Esc", description: "Interrupt generation / dismiss picker" },
  { keys: "Ctrl+C", description: "Exit DeepSeek Code" },
];

/** The command catalog, grouped by topic. */
export const HELP_GROUPS: CommandGroup[] = [
  {
    title: "Setup & model",
    commands: [
      {
        name: "/setup",
        description: "Guided one-command model/API setup",
        usage: [
          "/setup <api-key> [model]",
          "/setup <preset> <key> [model]",
          "/setup custom <provider> <model> <key> [baseurl]",
        ],
      },
      {
        name: "/model",
        description: "Show current model info, or switch model/profile",
        usage: ["/model <name>", "/model set <provider> <model> [baseurl]"],
      },
      {
        name: "/models",
        description: "List configured profiles",
      },
      {
        name: "/apikey",
        description: "Set the API key for current provider",
        usage: ["/apikey <key>"],
      },
      {
        name: "/baseurl",
        description: "Set custom endpoint URL",
        usage: ["/baseurl <url>", "/baseurl clear"],
      },
    ],
  },
  {
    title: "Agents & reasoning",
    commands: [
      {
        name: "/agent",
        description: "Switch agent (code, plan, review)",
        usage: ["/agent <name>"],
      },
      {
        name: "/think",
        description: "Toggle whalethink (extended reasoning)",
        usage: ["/think off", "/think whale"],
      },
      {
        name: "/effort",
        description: "Set reasoning effort (opens a selector with no args)",
        usage: ["/effort [low|medium|high|xhigh|max|auto]"],
      },
      {
        name: "/plan",
        description: "Switch to the plan agent (read-only)",
      },
      {
        name: "/review",
        description: "Review uncommitted changes with the review agent",
        usage: ["/review", "/security-review"],
      },
      {
        name: "/skills",
        description: "List available skills",
        usage: ["/skills <name>"],
      },
      {
        name: "/tools",
        description: "List available tools (includes LSP code intelligence: goToDefinition, findReferences, hover, …)",
      },
      {
        name: "/hooks",
        description: "List configured lifecycle hooks (PreToolUse, etc.)",
      },
    ],
  },
  {
    title: "Project",
    commands: [
      {
        name: "/init",
        description: "Create a CLAUDE.md guidance file for this project",
      },
      {
        name: "/memory",
        description: "Show/edit the project memory file (CLAUDE.md)",
      },
      {
        name: "/permissions",
        description: "Show configured permission rules",
      },
      {
        name: "/workspace",
        description: "Show workspace path and trust status",
        usage: ["/add-dir (see /workspace)"],
      },
      {
        name: "/branch",
        description: "Show the current git branch",
      },
      {
        name: "/env",
        description: "Show environment variable configuration",
      },
    ],
  },
  {
    title: "Sessions & history",
    commands: [
      {
        name: "/sessions",
        description: "List saved sessions",
        usage: ["/sessions clear"],
      },
      {
        name: "/resume",
        description: "Resume a saved session",
        usage: ["/resume <hash>"],
      },
      {
        name: "/history",
        description: "Show message history numbers for rewinding",
        aliases: ["/messages"],
      },
      {
        name: "/rewind",
        description: "Truncate history back to a message (restores file snapshots)",
        usage: ["/rewind <number>"],
      },
      {
        name: "/search",
        description: "Search the conversation (text or regex)",
        usage: ["/search <query>"],
      },
      {
        name: "/export",
        description: "Export conversation to a file",
        usage: ["/export [markdown|json]"],
      },
      {
        name: "/compact",
        description: "Summarize conversation to save context",
      },
      {
        name: "/copy",
        description: "Copy last assistant response to clipboard",
      },
      {
        name: "/clear",
        description: "Clear conversation history",
      },
    ],
  },
  {
    title: "Git & diagnostics",
    commands: [
      {
        name: "/commit",
        description: "Create a git commit from changes",
      },
      {
        name: "/pr",
        description: "Commit, push, and create a GitHub pull request",
      },
      {
        name: "/diff",
        description: "Show git diff of working directory changes",
      },
      {
        name: "/doctor",
        description: "Run diagnostics on git, network, and bindings",
      },
      {
        name: "/cost",
        description: "Show token usage and cost",
      },
      {
        name: "/usage",
        description: "Open the tabbed Settings UI on the Usage tab (sessions, tokens, activity)",
      },
    ],
  },
  {
    title: "System",
    commands: [
      {
        name: "/help",
        description: "Show this help",
      },
      {
        name: "/mcp",
        description: "Show MCP servers and status",
        usage: ["/mcp enable <name>", "/mcp disable <name>"],
      },
      {
        name: "/queue",
        description: "Show queued prompts",
        usage: ["/queue clear"],
      },
      {
        name: "/shortcuts",
        description: "Toggle shortcuts panel",
      },
      {
        name: "/statusline",
        description: "Show/set the custom status line (Claude Code parity)",
        usage: ["/statusline <command>", "/statusline off"],
      },
      {
        name: "/settings",
        description: "Open the legacy settings overlay",
        usage: ["/settings · /stats"],
      },
      {
        name: "/config",
        description: "Open the tabbed Settings UI on the Config tab (searchable settings)",
        usage: ["/config · type to filter, Enter to edit a setting"],
      },
      {
        name: "/status",
        description: "Open the tabbed Settings UI on the Status tab (session diagnostics)",
      },
      {
        name: "/theme",
        description: "Show/set the color theme (auto/dark/light/daltonized/ansi)",
        usage: ["/theme <setting>"],
      },
      {
        name: "/output-style",
        description: "Show/set the output style",
        usage: ["/output-style <name>"],
      },
      {
        name: "/context",
        description: "Show context window usage",
      },
      {
        name: "/todos",
        description: "Show the agent's todo list",
      },
      {
        name: "/bashes",
        description: "List background tasks",
      },
      {
        name: "/plugins",
        description: "Open plugin management (installed plugins + browse the official Anthropic and community marketplaces)",
        aliases: ["/plugin"],
      },
      {
        name: "/exit",
        description: "Exit DeepSeek Code",
      },
    ],
  },
];

/** All command names (with aliases), used by HelpView to render /help output. */
export function allCommandNames(): string[] {
  const names: string[] = [];
  for (const group of HELP_GROUPS) {
    for (const cmd of group.commands) {
      names.push(cmd.name);
      for (const alias of cmd.aliases ?? []) {
        names.push(alias);
      }
    }
  }
  return names;
}
