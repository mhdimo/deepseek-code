



import React from "react";
import { Box, Text } from "ink";
import { theme } from "../utils/theme.js";

interface FileMentionsProps {
  matches: string[];
  selectedIndex: number;
  query: string;
}

export default function FileMentions({ matches, selectedIndex, query }: FileMentionsProps): React.ReactElement | null {
  if (matches.length === 0) return null;
  const cols = process.stdout.columns || 80;
  const maxW = cols - 6;

  return (
    <Box flexDirection="column" paddingX={2} marginTop={0}>
      <Text dimColor>
        {"  @ "}
        {query ? `files matching "${query}" · ` : "files · "}
        {matches.length} shown
      </Text>
      {matches.map((path, i) => {
        const active = i === selectedIndex;
        const trimmed = path.length > maxW ? "…" + path.slice(-(maxW - 1)) : path;
        const slash = trimmed.lastIndexOf("/");
        const dir = slash > 0 ? trimmed.slice(0, slash + 1) : "";
        const file = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
        return (
          <Box key={`${path}-${i}`} flexDirection="row">
            <Text color="cyan">{active ? "▶ " : "  "}</Text>
            <Text color={active ? theme.assistant : "gray"} bold={active}>
              {dir}
            </Text>
            <Text color={active ? theme.assistant : undefined} bold={active}>
              {file}
            </Text>
          </Box>
        );
      })}
      <Text dimColor>  Tab insert · ↑↓ navigate · Esc dismiss</Text>
    </Box>
  );
}
