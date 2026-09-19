import React from "react";
import { Box, Text } from "ink";
import { getTheme, getThemeMode, resolveColor, type Theme } from "../utils/theme.js";
import { Pane } from "../ui/design-system/Pane.js";
import { Tab, Tabs } from "../ui/design-system/Tabs.js";
import {
  HELP_FOOTER,
  HELP_GROUPS,
  HELP_INTRO,
  KEYBOARD_SHORTCUTS,
  type HelpCommand,
} from "../constants/help.js";

interface HelpViewProps {
  version?: string;
  /** User/project slash commands — rendered in the `custom-commands` tab. */
  customCommands?: readonly HelpCommand[];
}


const NAME_WIDTH = 14;

export default function HelpView({ version, customCommands }: HelpViewProps) {
  const theme: Theme = getTheme(getThemeMode() === "light" ? "light" : "dark");
  const color = (token: keyof Theme): string => resolveColor(theme[token]!);

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

  const custom = customCommands ?? [];

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Claude Code renders the help screen as a Pane — one colored top rule
          with horizontal padding, no side or bottom border — and hangs the
          version string off the tab strip as its title. */}
      <Pane color="professionalBlue">
        <Tabs
          title={`DeepSeek Code v${version ?? ""}`}
          color="professionalBlue"
          defaultTab="general"
        >
          <Tab title="general">
            <Box flexDirection="column" paddingY={1} gap={1}>
              <Box>
                <Text>{HELP_INTRO}</Text>
              </Box>
              <Box flexDirection="column">
                <Box>
                  <Text bold>Shortcuts</Text>
                </Box>
                <Box flexDirection="column">
                  {KEYBOARD_SHORTCUTS.map((shortcut) => (
                    <Box key={shortcut.keys} marginLeft={2}>
                      <Text color={color("permission")}>{shortcut.keys.padEnd(NAME_WIDTH)}</Text>
                      <Text dimColor>{shortcut.description}</Text>
                    </Box>
                  ))}
                </Box>
              </Box>
            </Box>
          </Tab>

          <Tab title="commands">
            <Box flexDirection="column" paddingY={1}>
              <Text>Browse default commands:</Text>
              <Box flexDirection="column" marginTop={1}>
                {HELP_GROUPS.map((group) => (
                  <Box key={group.title} flexDirection="column" marginBottom={1}>
                    <Text bold color={color("claude")}>
                      {group.title}
                    </Text>
                    {group.commands.map(renderCommand)}
                  </Box>
                ))}
              </Box>
            </Box>
          </Tab>

          <Tab title="custom-commands">
            <Box flexDirection="column" paddingY={1}>
              {custom.length === 0 ? (
                <Text dimColor>No custom commands found</Text>
              ) : (
                <>
                  <Text>Browse custom commands:</Text>
                  <Box flexDirection="column" marginTop={1}>
                    {custom.map(renderCommand)}
                  </Box>
                </>
              )}
            </Box>
          </Tab>
        </Tabs>

        <Box marginTop={1}>
          <Text dimColor>{HELP_FOOTER}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor italic>
            esc to cancel
          </Text>
        </Box>
      </Pane>
    </Box>
  );
}
