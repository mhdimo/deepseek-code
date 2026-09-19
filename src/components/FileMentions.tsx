



import React from "react";
import { Box, Text } from "ink";
import { theme, resolveColor } from "../utils/theme.js";

interface FileMentionsProps {
  matches: string[];
  selectedIndex: number;
  query: string;
}

export default function FileMentions({ matches, selectedIndex }: FileMentionsProps): React.ReactElement | null {
  if (matches.length === 0) return null;
  const cols = process.stdout.columns || 80;
  const maxW = cols - 6;

  return (
    <Box flexDirection="column" paddingX={2} marginTop={0}>
      {matches.map((path, i) => {
        const active = i === selectedIndex;
        const trimmed = path.length > maxW ? "…" + path.slice(-(maxW - 1)) : path;
        return (
          // '+' icon prefix, one Text per row, colour-only selection: the
          // selected row takes the suggestion colour, the rest stay dim
          // default — no pointer column, no bold.
          <Text
            key={`${path}-${i}`}
            color={active ? resolveColor(theme.suggestion) : undefined}
            dimColor={!active}
            wrap="truncate"
          >
            {"+ "}
            {trimmed}
          </Text>
        );
      })}
    </Box>
  );
}
