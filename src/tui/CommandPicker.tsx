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
  category?: "core" | "model" | "agent" | "session" | "mcp";
  aliases?: string[];
}

export const ALL_COMMANDS: CommandDef[] = [
  { name: "/help",    description: "Show help & keybindings", category: "core", aliases: ["/?", "/shortcuts"] },
  { name: "/shortcuts", description: "Toggle shortcuts/options panel", category: "core", aliases: ["/?"] },
  { name: "/think",   description: "Set thinking mode (off/light/deep/max)", usage: "/think ", category: "core", aliases: ["/reason"] },
  { name: "/setup",   description: "Quick setup API key", usage: "/setup ", category: "model" },
  { name: "/model",   description: "Show or switch model", usage: "/model ", category: "model" },
  { name: "/models",  description: "List configured profiles", category: "model" },
  { name: "/apikey",  description: "Set API key", usage: "/apikey ", category: "model", aliases: ["/key"] },
  { name: "/agent",   description: "Switch agent (code / plan / review)", usage: "/agent ", category: "agent" },
  { name: "/tools",   description: "List available tools for current agent", category: "agent" },
  { name: "/mcp",     description: "Show MCP connections and toggle servers", usage: "/mcp ", category: "mcp", aliases: ["/servers"] },
  { name: "/clear",   description: "Clear conversation history", category: "session" },
  { name: "/compact", description: "Summarize conversation to save context", category: "session" },
  { name: "/exit",    description: "Exit DeepSeek Code", category: "core", aliases: ["/quit"] },
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
    .slice(0, 8);
}

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
        const category = cmd.category || "core";
        return (
          <Box key={cmd.name}>
            <Text color="cyan">{active ? "▸ " : "  "}</Text>
            <Text color={active ? "cyan" : "white"} bold={active}>
              {cmd.name.padEnd(10)}
            </Text>
            <Text color={active ? "white" : undefined} dimColor={!active}>
              [{category}] {cmd.description}
            </Text>
          </Box>
        );
      })}
      <Box paddingTop={0}>
        <Text dimColor>↑↓ navigate · ↵/Tab select · Esc dismiss · type ? for shortcuts</Text>
      </Box>
    </Box>
  );
}
