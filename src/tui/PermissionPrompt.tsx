// Permission prompt component (like Claude Code's tool approval dialog)

import React from "react";
import { Box, Text, useInput } from "ink";

interface PermissionPromptProps {
  toolName: string;
  description: string;
  onApprove: () => void;
  onDeny: () => void;
}

export default function PermissionPrompt({
  toolName,
  description,
  onApprove,
  onDeny,
}: PermissionPromptProps) {
  const descriptionLines = description.split("\n");

  const lineColor = (line: string): string | undefined => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("+")) return "green";
    if (trimmed.startsWith("-")) return "red";
    if (trimmed.startsWith("@@") || trimmed === "Diff preview:") return "cyan";
    return undefined;
  };

  useInput((input, key) => {
    if (input === "y" || input === "Y" || key.return) {
      onApprove();
    } else if (input === "n" || input === "N" || key.escape) {
      onDeny();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={0}
      marginY={0}
    >
      <Box>
        <Text color="yellow" bold>
          ⚡ Permission required
        </Text>
      </Box>
      <Box>
        <Text>
          <Text bold>{toolName}</Text>
          <Text dimColor> wants to:</Text>
        </Text>
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        {descriptionLines.map((line, i) => (
          <Text key={`${toolName}-line-${i}`} wrap="wrap" color={lineColor(line)} dimColor={!lineColor(line)}>
            {line || " "}
          </Text>
        ))}
      </Box>
      <Box>
        <Text dimColor>Press </Text>
        <Text color="green" bold>y</Text>
        <Text dimColor> to allow, </Text>
        <Text color="red" bold>n</Text>
        <Text dimColor> to deny</Text>
      </Box>
    </Box>
  );
}
