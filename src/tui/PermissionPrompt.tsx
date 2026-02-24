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
          <Text dimColor> wants to: </Text>
          <Text>{description}</Text>
        </Text>
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
