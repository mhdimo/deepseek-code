// Welcome screen with DeepSeek Code branding and command reference

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { basename } from "path";

// DeepSeek-style animated mascot
const MASCOT_FRAMES = [
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
}

export default function WelcomeScreen({
  version,
  model,
  workingDirectory,
  hasApiKey = true,
}: WelcomeScreenProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % MASCOT_FRAMES.length);
    }, 400);
    return () => clearInterval(timer);
  }, []);

  const mascot = MASCOT_FRAMES[frame]!;
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
      {/* Header */}
      <Box>
        <Box flexDirection="column">
          <Text color="blue">{mascot.top}</Text>
          <Text color="blue">{mascot.mid}</Text>
          <Text color="blue">{mascot.bot}</Text>
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          <Text>
            <Text color="cyan" bold>DeepSeek</Text>
            <Text color="blue" bold> Code</Text>
            <Text dimColor> v{version}</Text>
          </Text>
          <Text dimColor>{model} · 📁 {cwdDisplay}</Text>
        </Box>
      </Box>

      {/* API key warning or status */}
      {!hasApiKey ? (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text backgroundColor="red" color="white" bold> ⚠ NO API KEY </Text>
            <Text> </Text>
            <Text dimColor>Paste your key below or use /setup</Text>
          </Box>
          <Box marginLeft={1} marginTop={1}>
            <Text dimColor>Get a key: </Text>
            <Text color="cyan">https://platform.deepseek.com/api_keys</Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text backgroundColor="green" color="white" bold> ✓ READY </Text>
        </Box>
      )}

      {/* Footer hint */}
      <Box>
        <Text dimColor>Type </Text>
        <Text color="cyan" bold>/</Text>
        <Text dimColor> to open command picker · </Text>
        <Text color="cyan" bold>?</Text>
        <Text dimColor> for shortcuts · </Text>
        <Text color="cyan" bold>↑↓</Text>
        <Text dimColor> input history</Text>
      </Box>
    </Box>
  );
}
