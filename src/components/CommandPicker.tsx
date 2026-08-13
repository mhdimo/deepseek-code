




import React from "react";
import { Box, Text } from "ink";



export interface CommandDef {
  name: string;         
  description: string;  
  
  usage?: string;
  category?: "general" | "session" | "model" | "agent" | "mcp" | "project";
  aliases?: string[];
}

export const ALL_COMMANDS: CommandDef[] = [
  
  { name: "/help",    description: "Show help & keybindings", category: "general", aliases: ["/?", "/shortcuts"] },
  { name: "/shortcuts", description: "Toggle shortcuts panel", category: "general", aliases: ["/?"] },
  { name: "/think",   description: "Toggle thinking mode (off / whale)", usage: "/think ", category: "general", aliases: ["/reason"] },
  { name: "/effort",  description: "Set reasoning effort (low/medium/high/xhigh/max)", usage: "/effort ", category: "general" },
  { name: "/theme",   description: "Show or set the color theme", usage: "/theme ", category: "general" },
  { name: "/output-style", description: "Show or set the output style", usage: "/output-style ", category: "general" },
  { name: "/permissions", description: "Show configured permission rules", category: "general" },
  { name: "/env",     description: "Show environment variable configuration", category: "general" },
  { name: "/init",    description: "Create a CLAUDE.md for this project", category: "project" },
  { name: "/memory",  description: "Edit the project memory file (CLAUDE.md)", category: "project" },
  { name: "/review",  description: "Review uncommitted changes with the review agent", category: "project" },
  { name: "/security-review", description: "Security review of uncommitted changes", category: "project" },
  { name: "/branch",  description: "Show the current git branch", category: "project" },
  { name: "/workspace", description: "Show workspace path and trust status", category: "project" },
  { name: "/context", description: "Show context window usage", category: "session" },
  { name: "/todos",   description: "Show the agent's todo list", category: "session" },
  { name: "/bashes",  description: "List background tasks", category: "session" },
  { name: "/plan",    description: "Switch to the plan agent (read-only)", category: "agent" },
  { name: "/cost",    description: "Show session cost and token usage", category: "general", aliases: ["/usage"] },
  { name: "/usage",   description: "Show session cost and token usage", category: "general" },
  { name: "/settings", description: "Show general settings", category: "general" },
  { name: "/status",   description: "Show session status and details", category: "general" },
  { name: "/stats",    description: "Show calendar contribution and usage stats", category: "general" },
  { name: "/config",   description: "Show loaded configuration files", category: "general" },
  { name: "/doctor",   description: "Run diagnostics on git, network, and C++ bindings", category: "general" },
  { name: "/hooks",    description: "List configured lifecycle hooks", category: "general" },
  { name: "/plugin",   description: "Manage plugins and browse marketplaces", category: "general", aliases: ["/plugins"] },

  
  { name: "/clear",   description: "Clear conversation history and free context", category: "session" },
  { name: "/compact", description: "Summarize conversation to save context. Optional: /compact [instructions]", category: "session" },
  { name: "/sessions", description: "List saved sessions", category: "session" },
  { name: "/resume",  description: "Resume a saved session by hash", usage: "/resume ", category: "session" },
  { name: "/commit",  description: "Create a git commit from staged/unstaged changes", category: "session" },
  { name: "/pr",      description: "Commit, push, and create a GitHub pull request", category: "session" },
  { name: "/copy",     description: "Copy last response (or /copy N) to clipboard", usage: "/copy ", category: "session" },
  { name: "/diff",     description: "Show git diff of the current changes", category: "session" },
  { name: "/history",  description: "Show conversation history message numbers", category: "session", aliases: ["/messages"] },
  { name: "/rewind",   description: "Rewind conversation back to a specific message", usage: "/rewind ", category: "session" },
  { name: "/exit",    description: "Exit DeepSeek Code", category: "session", aliases: ["/quit"] },

  
  { name: "/setup",   description: "Quick API key setup", usage: "/setup ", category: "model" },
  { name: "/model",   description: "Show or switch model / profile", usage: "/model ", category: "model" },
  { name: "/models",  description: "List available models and profiles", category: "model" },
  { name: "/apikey",  description: "Set or update API key", usage: "/apikey ", category: "model", aliases: ["/key"] },
  { name: "/baseurl", description: "Set custom API base URL", usage: "/baseurl ", category: "model" },

  
  { name: "/agent",   description: "Switch agent (code / plan / review)", usage: "/agent ", category: "agent" },
  { name: "/tools",   description: "List available tools for current agent", category: "agent" },

  
  { name: "/mcp",     description: "Show MCP connections and toggle servers", usage: "/mcp ", category: "mcp", aliases: ["/servers"] },
];

function rankCommand(cmd: CommandDef, query: string): number {
  const q = query.toLowerCase();
  const n = cmd.name.toLowerCase();
  const d = cmd.description.toLowerCase();
  const aliases = (cmd.aliases || []).map((a) => a.toLowerCase());

  if (n === q) return 100;
  if (aliases.includes(q)) return 95;
  if (n.startsWith(q)) return 90;
  if (aliases.some((a) => a.startsWith(q))) return 80;
  if (n.includes(q)) return 70;
  if (aliases.some((a) => a.includes(q))) return 60;
  if (d.includes(q)) return 40;
  return -1;
}

export function filterCommands(query: string, customCommands: CommandDef[] = []): CommandDef[] {
  const q = query.trim().toLowerCase();
  if (!q.startsWith("/")) return [];
  if (q.includes(" ")) return [];

  
  
  return [...ALL_COMMANDS, ...customCommands]
    .map((cmd) => ({ cmd, score: rankCommand(cmd, q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name))
    .map((x) => x.cmd);
}



interface CommandPickerProps {
  commands: CommandDef[];
  selectedIndex: number;
}


const MAX_VISIBLE = 10;

export default React.memo(function CommandPicker({ commands, selectedIndex }: CommandPickerProps) {
  if (commands.length === 0) return null;

  
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), commands.length - MAX_VISIBLE));
  const visible = commands.slice(start, start + MAX_VISIBLE);
  const showTopEllipsis = start > 0;
  const showBottomEllipsis = start + MAX_VISIBLE < commands.length;

  
  
  return (
    <Box flexDirection="column" paddingX={2}>
      {showTopEllipsis && <Text dimColor>…</Text>}
      {visible.map((cmd, i) => {
        const active = i + start === selectedIndex;
        return (
          <Box key={cmd.name}>
            <Text color={active ? "white" : "gray"} bold={active}>
              {cmd.name.padEnd(34)}
            </Text>
            <Text color={active ? "white" : undefined} dimColor={!active} wrap="truncate-end">
              {cmd.description}
            </Text>
          </Box>
        );
      })}
      {showBottomEllipsis && <Text dimColor>…</Text>}
    </Box>
  );
});