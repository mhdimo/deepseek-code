import React from "react";
import { Box, Text, useStdout } from "ink";

import {
  filterCommandDefinitions,
  type CommandDefinition,
} from "../services/commands/commandRegistry.js";
import { commandColumnWidth, truncateCommandDescription, visibleCommandRange } from "./commandPickerLayout.js";
import { getTheme, getThemeMode, resolveColor } from "../utils/theme.js";
import { useClickRegion, type RegionClickEvent } from "./mouseRegions.js";

export type CommandDef = CommandDefinition;

// Compatibility export for App and integrations that used the old picker module.
export { BUILTIN_COMMANDS as ALL_COMMANDS } from "../services/commands/commandRegistry.js";

export function filterCommands(
  query: string,
  customCommands: readonly CommandDef[] = [],
): CommandDef[] {
  return filterCommandDefinitions(query, customCommands);
}

interface CommandPickerProps {
  commands: readonly CommandDef[];
  selectedIndex: number;
  /** Click activation: the index into `commands` (Enter's semantics). */
  onPick?: (index: number) => void;
}

const MAX_VISIBLE = 6;

export default React.memo(function CommandPicker({ commands, selectedIndex, onPick }: CommandPickerProps) {
  if (commands.length === 0) return null;

  const { stdout } = useStdout();
  const columns = stdout.columns || process.stdout.columns || 80;
  const nameWidth = commandColumnWidth(columns);
  const descriptionWidth = Math.max(8, columns - nameWidth - 6);
  const range = visibleCommandRange(commands.length, selectedIndex, MAX_VISIBLE);
  const start = range.start;
  const visible = commands.slice(start, start + MAX_VISIBLE);
  const showTopEllipsis = range.start > 0;
  const showBottomEllipsis = range.end < commands.length;
  const theme = getTheme(getThemeMode() === "light" ? "light" : "dark");

  // Rows are single-line (truncate, never wrap), so the list is one region
  // and the click row maps straight through. The top "…" marker is a row.
  const handleRegionClick = (ev: RegionClickEvent): void => {
    if (!onPick) return;
    const row = ev.row - (showTopEllipsis ? 1 : 0);
    if (row < 0 || row >= visible.length) return; // the "…" markers themselves
    onPick(start + row);
  };
  const regionRef = useClickRegion(handleRegionClick, Boolean(onPick));

  return (
    <Box flexDirection="column" paddingX={2} ref={regionRef}>
      {showTopEllipsis && <Text dimColor>…</Text>}
      {visible.map((cmd, i) => {
          const active = i + start === selectedIndex;
        return (
          <Box key={cmd.name}>
            <Text color={active ? resolveColor(theme.suggestion) : undefined} bold={active} dimColor={!active}>
              {`/${cmd.name}`.padEnd(nameWidth)}
            </Text>
            <Text color={active ? resolveColor(theme.suggestion) : undefined} dimColor={!active} wrap="truncate-end">
              {truncateCommandDescription(cmd.description, descriptionWidth)}
            </Text>
          </Box>
        );
      })}
      {showBottomEllipsis && <Text dimColor>…</Text>}
    </Box>
  );
});
