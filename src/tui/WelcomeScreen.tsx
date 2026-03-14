// Welcome screen styled like Claude-like UI with Zcode branding

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { basename } from "path";

const MASCOT_FRAMES = [
  {
    top: "▐▛███▜▌",
    mid: "▝▜█████▛▘",
    bot: "  ▘▘ ▝▝",
  },
  {
    top: "▐▛███▜▌",
    mid: "▝▜█████▛▘",
    bot: "  ▝▝ ▘▘",
  },
  {
    top: "▐▛███▜▌",
    mid: "▝▜█████▛▘",
    bot: "  ▘▝ ▝▘",
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
    }, 260);
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
        <Text color="white"> {mascot.top}</Text>
        <Text>   </Text>
        <Text color="white">Zcode</Text>
        <Text dimColor> v{version}</Text>
      </Box>

      <Box>
        <Text color="white">{mascot.mid}</Text>
        <Text>  </Text>
        <Text dimColor>{model}</Text>
        <Text dimColor> · </Text>
        <Text dimColor>API Usage Billing</Text>
      </Box>

      <Box>
        <Text color="white">{mascot.bot}</Text>
        <Text>    </Text>
        <Text dimColor>{cwdDisplay}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>/setup for quick provider/model/api-key setup</Text>
        <Text dimColor>  ·  provider: {providerType}</Text>
      </Box>
    </Box>
  );
}
