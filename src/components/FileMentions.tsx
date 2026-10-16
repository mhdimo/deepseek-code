



import React from "react";
import { Box, Text } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import { useClickRegion, type RegionClickEvent } from "./mouseRegions.js";

interface FileMentionsProps {
  matches: string[];
  selectedIndex: number;
  query: string;
  /** Click activation: fill this match in at the mention's position. */
  onPick?: (index: number) => void;
}

export default function FileMentions({ matches, selectedIndex, onPick }: FileMentionsProps): React.ReactElement | null {
  if (matches.length === 0) return null;
  const cols = process.stdout.columns || 80;
  const maxW = cols - 6;

  // Each match is exactly one row (truncate, never wrap), so the list is one
  // region and the row index is the match index.
  const handleRegionClick = (ev: RegionClickEvent): void => {
    if (!onPick) return;
    if (ev.row < 0 || ev.row >= matches.length) return;
    onPick(ev.row);
  };
  const regionRef = useClickRegion(handleRegionClick, Boolean(onPick));

  return (
    <Box flexDirection="column" paddingX={2} marginTop={0} ref={regionRef}>
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
