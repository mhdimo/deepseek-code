











import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { basename } from "path";
import { getTheme, getThemeMode, resolveColor, type Theme } from "../utils/theme.js";




export const MASCOT_FRAMES = [
  {
    top: "    ▄▄▄▄▄▄▄    ",
    mid: "  ▄▀░░░░░░░▀▄  ",
    bot: " █░░▄░░░░▄░░░█  ",
  },
  {
    top: "    ▄▄▄▄▄▄▄    ",
    mid: "  ▄▀░░░░░░░▀▄  ",
    bot: " █░░▀░░░░▀░░░█  ",
  },
  {
    top: "    ▄▄▄▄▄▄▄    ",
    mid: "  ▄▀░░░░░░░▀▄  ",
    bot: " █░░░░██░░░░░█  ",
  },
] as const;

interface WelcomeScreenProps {
  version: string;
  model: string;
  workingDirectory: string;
  agentName: string;
  providerType: string;
  baseURL?: string;
  hasApiKey?: boolean;
  
  frozen?: boolean;
}


const FEATURE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "TodoWrite",
  "Agent",
];


const LABEL_WIDTH = 12;

export default function WelcomeScreen({
  version,
  model,
  workingDirectory,
  agentName,
  providerType,
  baseURL,
  hasApiKey = true,
  frozen = false,
}: WelcomeScreenProps) {
  
  
  void frozen;
  const mascot = MASCOT_FRAMES[0];
  const theme: Theme = getTheme(getThemeMode() === "light" ? "light" : "dark");
  const color = (token: keyof Theme): string => resolveColor(theme[token]!);

  const cwdDisplay = useMemo(() => {
    if (!workingDirectory) return "~";
    const home = process.env.HOME;
    if (home && workingDirectory.startsWith(home)) {
      const tail = workingDirectory.slice(home.length);
      return `~${tail || "/"}`;
    }
    return `~/${basename(workingDirectory)}`;
  }, [workingDirectory]);

  return (
    <Box flexDirection="column" marginLeft={1} marginBottom={1}>
      <Box borderStyle="round" borderColor={color("claude")} paddingX={1} paddingBottom={1} flexDirection="column">
        {}
        <Box>
          <Box flexDirection="column">
            <Text color={color("claude")}>{mascot.top}</Text>
            <Text color={color("claude")}>{mascot.mid}</Text>
            <Text color={color("claude")}>{mascot.bot}</Text>
          </Box>
          <Box flexDirection="column" marginLeft={2}>
            <Text>
              <Text color={color("claude")} bold>
                DeepSeek
              </Text>
              <Text color={color("claudeShimmer")} bold>
                {" "}Code
              </Text>
              <Text dimColor> v{version}</Text>
            </Text>
            <Text dimColor>
              {model} · {cwdDisplay}
            </Text>
          </Box>
        </Box>

        {}
        <Box marginTop={1}>
          {!hasApiKey ? (
            <Box flexDirection="column">
              <Box>
                <Text backgroundColor={color("error")} color={color("inverseText")} bold>
                  {" "}NO API KEY{" "}
                </Text>
                <Text> </Text>
                <Text dimColor>Paste your key below or use /setup</Text>
              </Box>
              <Box marginLeft={1} marginTop={1}>
                <Text dimColor>Get a key: </Text>
                <Text color={color("claude")}>https://platform.deepseek.com/api_keys</Text>
              </Box>
            </Box>
          ) : (
            <Box>
              <Text backgroundColor={color("success")} color={color("inverseText")} bold>
                {" "}✓ READY{" "}
              </Text>
              <Text> </Text>
              <Text dimColor>
                agent: {agentName} · provider: {providerType}
                {baseURL ? ` · base: ${baseURL}` : ""}
              </Text>
            </Box>
          )}
        </Box>

        {}
        <Box marginTop={1} flexDirection="column">
          <Text bold color={color("claude")}>
            Quick start
          </Text>
          <Box marginLeft={2}>
            <Text color={color("claude")} bold>
              /{" ".padEnd(2)}
            </Text>
            <Text dimColor>Open the command picker</Text>
          </Box>
          <Box marginLeft={2}>
            <Text color={color("claude")} bold>
              ?{" ".padEnd(3)}
            </Text>
            <Text dimColor>Show keyboard shortcuts</Text>
          </Box>
          <Box marginLeft={2}>
            <Text color={color("claude")} bold>
              ↑↓{" ".padEnd(1)}
            </Text>
            <Text dimColor>Input history</Text>
          </Box>
          <Box marginLeft={2}>
            <Text color={color("claude")} bold>
              -p{" ".padEnd(1)}
            </Text>
            <Text dimColor>
              Headless mode: <Text color={color("claude")}>deepseek-code -p "fix the failing tests"</Text>
            </Text>
          </Box>
        </Box>

        {}
        <Box marginTop={1} flexDirection="column">
          <Text bold color={color("claude")}>
            Features
          </Text>
          <Box marginLeft={2}>
            <Text color={color("claude")}>{`Models`.padEnd(LABEL_WIDTH)}</Text>
            <Text dimColor>deepseek-chat (default) · deepseek-reasoner</Text>
          </Box>
          <Box marginLeft={2}>
            <Text color={color("claude")}>{`Thinking`.padEnd(LABEL_WIDTH)}</Text>
            <Text dimColor>
              whalethink (<Text color={color("claude")}>/think</Text>) · <Text color={color("claude")}>/effort</Text> low|medium|high|xhigh|max
            </Text>
          </Box>
          <Box marginLeft={2}>
            <Text color={color("claude")}>{`Skills`.padEnd(LABEL_WIDTH)}</Text>
            <Text dimColor>
              <Text color={color("claude")}>/skills</Text> — discover and run project skills
            </Text>
          </Box>
          <Box marginLeft={2}>
            <Text color={color("claude")}>{`Tools`.padEnd(LABEL_WIDTH)}</Text>
            <Text dimColor>{FEATURE_TOOLS.join(" · ")}</Text>
          </Box>
        </Box>
      </Box>

      {}
      <Box>
        <Text dimColor>Type </Text>
        <Text color={color("claude")} bold>/</Text>
        <Text dimColor> to open command picker · </Text>
        <Text color={color("claude")} bold>?</Text>
        <Text dimColor> for shortcuts · </Text>
        <Text color={color("claude")} bold>/help</Text>
        <Text dimColor> for the full command list</Text>
      </Box>
    </Box>
  );
}
