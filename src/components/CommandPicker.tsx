import React from "react";
import { Box, Text } from "ink";

import {
  filterCommandDefinitions,
  type CommandDefinition,
} from "../services/commands/commandRegistry.js";

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
}

const MAX_VISIBLE = 6;

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
              {`/${cmd.name}`}
            </Text>
            <Text color={active ? "white" : undefined} dimColor={!active}>
              {`  ${cmd.description}`}
            </Text>
          </Box>
        );
      })}
      {showBottomEllipsis && <Text dimColor>…</Text>}
    </Box>
  );
});
