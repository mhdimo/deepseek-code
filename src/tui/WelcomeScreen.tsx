// Welcome screen with Z-Code ASCII art

import React from "react";
import { Box, Text } from "ink";

const ASCII_ART = [
  "  ███████╗       ██████╗ ██████╗ ██████╗ ███████╗",
  "  ╚══███╔╝      ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "    ███╔╝ █████╗██║     ██║   ██║██║  ██║█████╗  ",
  "   ███╔╝  ╚════╝██║     ██║   ██║██║  ██║██╔══╝  ",
  "  ███████╗      ╚██████╗╚██████╔╝██████╔╝███████╗",
  "  ╚══════╝       ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];

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
  agentName,
  providerType,
  baseURL,
}: WelcomeScreenProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={2}
      paddingY={1}
    >
      {/* ASCII Art */}
      <Box flexDirection="column" marginBottom={1}>
        {ASCII_ART.map((line, i) => (
          <Text key={i} color="white">
            {line}
          </Text>
        ))}
      </Box>

      {/* Version line */}
      <Box>
        <Text dimColor>v{version}</Text>
        <Text dimColor> · </Text>
        <Text dimColor>provider: </Text>
        <Text color="white">{providerType}</Text>
        <Text dimColor> · </Text>
        <Text dimColor>model: </Text>
        <Text color="white">{model}</Text>
      </Box>

      {/* Base URL if custom */}
      {baseURL && (
        <Box>
          <Text dimColor>endpoint: </Text>
          <Text color="white">{baseURL}</Text>
        </Box>
      )}

      {/* Working directory + agent */}
      <Box marginBottom={1}>
        <Text dimColor>cwd: </Text>
        <Text color="white">{workingDirectory}</Text>
        <Text dimColor> · </Text>
        <Text dimColor>agent: </Text>
        <Text color="cyan" bold>{agentName}</Text>
      </Box>

      {/* Tips */}
      <Box>
        <Text dimColor>Type </Text>
        <Text color="white" bold>/help</Text>
        <Text dimColor> for commands · </Text>
        <Text color="white" bold>Esc</Text>
        <Text dimColor> to interrupt · </Text>
        <Text color="white" bold>Ctrl+C</Text>
        <Text dimColor> to exit</Text>
      </Box>
    </Box>
  );
}
