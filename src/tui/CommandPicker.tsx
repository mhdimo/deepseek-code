// CommandPicker — slash-command palette with keyboard navigation
//
// Appears above the input when the user types "/", filtered in real-time.
// Navigate with ↑↓, confirm with Enter or Tab, dismiss with Esc.

import React from "react";
import { Box, Text } from "ink";

// ─── Command registry ────────────────────────────────────────────────────────

export interface CommandDef {
  name: string;         // e.g. "/clear"
  description: string;  // short label shown in picker
  /** Text to fill the input on selection (leave undefined for no-arg commands) */
  usage?: string;
  category?: "general" | "session" | "model" | "agent" | "mcp";
  aliases?: string[];
}

export const ALL_COMMANDS: CommandDef[] = [
  // ─── General ──────────────────────────────────────────────────────
  { name: "/help",    description: "Show help & keybindings", category: "general", aliases: ["/?", "/shortcuts"] },
  { name: "/shortcuts", description: "Toggle shortcuts panel", category: "general", aliases: ["/?"] },
  { name: "/think",   description: "Toggle thinking mode (off / whale)", usage: "/think ", category: "general", aliases: ["/reason"] },
  { name: "/cost",    description: "Show session cost and token usage", category: "general" },

  // ─── Session ──────────────────────────────────────────────────────
  { name: "/clear",   description: "Clear conversation history and free context", category: "session" },
  { name: "/compact", description: "Summarize conversation to save context. Optional: /compact [instructions]", category: "session" },
  { name: "/sessions", description: "List saved sessions", category: "session" },
  { name: "/resume",  description: "Resume a saved session by hash", usage: "/resume ", category: "session" },
  { name: "/exit",    description: "Exit DeepSeek Code", category: "session", aliases: ["/quit"] },

  // ─── Model ────────────────────────────────────────────────────────
  { name: "/setup",   description: "Quick API key setup", usage: "/setup ", category: "model" },
  { name: "/model",   description: "Show or switch model / profile", usage: "/model ", category: "model" },
  { name: "/models",  description: "List available models and profiles", category: "model" },
  { name: "/apikey",  description: "Set or update API key", usage: "/apikey ", category: "model", aliases: ["/key"] },
  { name: "/baseurl", description: "Set custom API base URL", usage: "/baseurl ", category: "model" },

  // ─── Agent ────────────────────────────────────────────────────────
  { name: "/agent",   description: "Switch agent (code / plan / review)", usage: "/agent ", category: "agent" },
  { name: "/tools",   description: "List available tools for current agent", category: "agent" },

  // ─── MCP ──────────────────────────────────────────────────────────
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

export function filterCommands(query: string): CommandDef[] {
  const q = query.trim().toLowerCase();
  if (!q.startsWith("/")) return [];
  if (q.includes(" ")) return [];

  return ALL_COMMANDS
    .map((cmd) => ({ cmd, score: rankCommand(cmd, q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name))
    .map((x) => x.cmd)
    .slice(0, 10);
}

// ─── Category styling ────────────────────────────────────────────────────────

const CATEGORY_STYLES: Record<string, { label: string; color: string }> = {
  general: { label: "general", color: "gray" },
  session: { label: "session", color: "green" },
  model:   { label: "model",   color: "blue" },
  agent:   { label: "agent",   color: "magenta" },
  mcp:     { label: "mcp",     color: "yellow" },
};

// ─── Component ───────────────────────────────────────────────────────────────

interface CommandPickerProps {
  commands: CommandDef[];
  selectedIndex: number;
}

export default function CommandPicker({ commands, selectedIndex }: CommandPickerProps) {
  if (commands.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginX={0}>
      {commands.map((cmd, i) => {
        const active = i === selectedIndex;
        const category = cmd.category || "general";
        const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.general!;
        return (
          <Box key={cmd.name}>
            <Text color="cyan">{active ? "▸ " : "  "}</Text>
            <Text color={active ? "cyan" : "white"} bold={active}>
              {cmd.name.padEnd(12)}
            </Text>
            <Text color={style.color} dimColor={!active}>
              {cmd.description}
            </Text>
          </Box>
        );
      })}
      <Box paddingTop={0}>
        <Text dimColor>↑↓ navigate · ↵ select · Esc dismiss · type / for commands</Text>
      </Box>
    </Box>
  );
}
