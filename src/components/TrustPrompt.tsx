import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme, resolveColor } from "../utils/theme.js";

interface TrustPromptProps {
  /** The workspace being asked about, as the user would recognize it. */
  directory: string;
  /** The workspace config file that triggered the prompt. */
  configFile: string;
  onDecide(trusted: boolean): void;
}

/**
 * Asked once per workspace, before its `.deepseek-code.json` is allowed to
 * apply.
 *
 * The prompt is not a formality: that file can name MCP servers, which this
 * process will execute as commands, and can redirect `baseURL`, which decides
 * where the user's API key is sent. A cloned repository should not be able to
 * do either just by being opened.
 */
export default function TrustPrompt({ directory, configFile, onDecide }: TrustPromptProps) {
  const [selected, setSelected] = useState(0);

  const options = [
    { label: "Yes, I trust this folder", value: true },
    { label: "No, ignore its config", value: false },
  ];

  useInput((input, key) => {
    if (key.upArrow || key.downArrow) {
      setSelected((s) => (s === 0 ? 1 : 0));
      return;
    }
    if (key.return) {
      onDecide(options[selected]!.value);
      return;
    }
    if (key.escape) {
      onDecide(false);
      return;
    }
    // Number keys, matching the permission prompt.
    if (input === "1") onDecide(true);
    else if (input === "2") onDecide(false);
    else if (input === "y" || input === "Y") onDecide(true);
    else if (input === "n" || input === "N") onDecide(false);
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={resolveColor(theme.warning)}
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
        paddingX={1}
      >
        <Text bold color={resolveColor(theme.warning)}>
          Accessing workspace:
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={resolveColor(theme.text)}>{directory}</Text>
          <Text color={resolveColor(theme.inactive)}>
            carries {configFile}, which this project can set.
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={resolveColor(theme.text)}>
            Trusting it lets that file configure MCP servers — commands that run on your machine —
            and point API requests at a different base URL.
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {options.map((opt, i) => (
            <Text key={opt.label} color={resolveColor(i === selected ? theme.permission : theme.inactive)}>
              {i === selected ? "❯ " : "  "}
              {i + 1}. {opt.label}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color={resolveColor(theme.inactive)}>
            Enter to confirm · Esc to cancel
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
