// Welcome screen with DeepSeek Code branding

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { basename } from "path";

// DeepSeek-style animated mascot
const MASCOT_FRAMES = [
  {
    top: "    ▄▄▄▄▄▄▄    ",
    mid: "  ▄▀░░░░░░░▀▄  ",
    bot: " █░░▄░░░░▄░░█  ",
  },
  {
    top: "    ▄▄▄▄▄▄▄    ",
    mid: "  ▄▀░░░░░░░▀▄  ",
    bot: " █░░▀░░░░▀░░█  ",
  },
  {
    top: "    ▄▄▄▄▄▄▄    ",
    mid: "  ▄▀░░░░░░░▀▄  ",
    bot: " █░░░░██░░░░█  ",
  },
] as const;

interface WelcomeScreenProps {
  version: string;
  model: string;
  workingDirectory: string;
  agentName: string;
  providerType: string;
  baseURL?: string;
}

export default function WelcomeScreen({
  version,
  model,
  workingDirectory,
  providerType,
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
          <Text dimColor>{model}</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>📁 {cwdDisplay}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>/setup for quick API key setup</Text>
        <Text dimColor>  ·  </Text>
        <Text dimColor>provider: {providerType}</Text>
      </Box>
    </Box>
  );
}
