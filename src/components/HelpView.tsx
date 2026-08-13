















import React from "react";
import { Box, Text } from "ink";
import { getTheme, getThemeMode, resolveColor, type Theme } from "../utils/theme.js";
import {
  HELP_FOOTER,
  HELP_GROUPS,
  HELP_INTRO,
  KEYBOARD_SHORTCUTS,
  type HelpCommand,
} from "../constants/help.js";

interface HelpViewProps {
  
  version?: string;
}


const NAME_WIDTH = 14;

export default function HelpView({ version }: HelpViewProps) {
  const theme: Theme = getTheme(getThemeMode() === "light" ? "light" : "dark");
  const color = (token: keyof Theme): string => resolveColor(theme[token]);

  const renderCommand = (cmd: HelpCommand) => (
    <Box key={cmd.name} flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={color("claude")} bold>
          {cmd.name.padEnd(NAME_WIDTH)}
        </Text>
        <Text>
          {cmd.description}
          {cmd.aliases && cmd.aliases.length > 0 ? (
            <Text dimColor>  (also {cmd.aliases.join(", ")})</Text>
          ) : null}
        </Text>
      </Box>
      {cmd.usage?.map((line) => (
        <Text key={line} dimColor>
          {" ".repeat(NAME_WIDTH)} {line}
        </Text>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column" marginLeft={1} marginBottom={1}>
      <Box borderStyle="round" borderColor={color("ide")} paddingX={1} paddingBottom={1} flexDirection="column">
        {}
        <Box marginBottom={1}>
          <Text>
            <Text color={color("claude")} bold>
              DeepSeek Code
            </Text>
            <Text dimColor> v{version ?? ""}</Text>
          </Text>
        </Box>

        {}
        <Text dimColor>{HELP_INTRO}</Text>
        <Text> </Text>

        {}
        {HELP_GROUPS.map((group) => (
          <Box key={group.title} flexDirection="column" marginBottom={1}>
            <Text bold color={color("claude")}>
              {group.title}
            </Text>
            {group.commands.map(renderCommand)}
          </Box>
        ))}

        {}
        <Text bold color={color("claude")}>
          Keyboard
        </Text>
        {KEYBOARD_SHORTCUTS.map((shortcut) => (
          <Box key={shortcut.keys} marginLeft={2}>
            <Text color={color("permission")}>{shortcut.keys.padEnd(NAME_WIDTH)}</Text>
            <Text dimColor>{shortcut.description}</Text>
          </Box>
        ))}
      </Box>

      {}
      <Box marginTop={1}>
        <Text dimColor>{HELP_FOOTER}</Text>
      </Box>
      <Box>
        <Text dimColor italic>
          esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
