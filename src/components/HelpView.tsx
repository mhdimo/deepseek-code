// HelpView — renders the /help output.
//
// Ported from claude-code-main/src/components/HelpV2/ (HelpV2.tsx + Commands.tsx
// + General.tsx): a framed pane with the app wordmark as the header, an intro
// line, the command catalog grouped by topic (teal command names, dim usage
// lines), a keyboard-shortcuts section, and a dismiss hint in the footer.
//
// The claude-code reference uses the design-system Pane/Tabs/Select; stock Ink
// has none of those ported, so the pane is a plain bordered Box and the
// command list is a static list rendered from src/constants/help.ts (the
// reference's interactive Select is not needed — /help output is read-only).
//
// Command data lives in src/constants/help.ts and mirrors the real command
// switch in App.tsx. This component stays dumb: no props required beyond an
// optional version string for the header.

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
  /** App version shown in the header, e.g. "0.1.0". */
  version?: string;
}

/** Padding used to align command names before their descriptions. */
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
        {/* Header: wordmark + version (HelpV2's Tabs title) */}
        <Box marginBottom={1}>
          <Text>
            <Text color={color("claude")} bold>
              DeepSeek Code
            </Text>
            <Text dimColor> v{version ?? ""}</Text>
          </Text>
        </Box>

        {/* General tab content: intro line */}
        <Text dimColor>{HELP_INTRO}</Text>
        <Text> </Text>

        {/* Commands tab content: grouped catalog */}
        {HELP_GROUPS.map((group) => (
          <Box key={group.title} flexDirection="column" marginBottom={1}>
            <Text bold color={color("claude")}>
              {group.title}
            </Text>
            {group.commands.map(renderCommand)}
          </Box>
        ))}

        {/* Shortcuts section */}
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

      {/* Footer: docs link + dismiss hint */}
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
