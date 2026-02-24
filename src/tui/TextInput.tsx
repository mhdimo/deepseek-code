// Input component (matches Claude Code's ❯ prompt)

import React from "react";
import { Box, Text } from "ink";
import InkTextInput from "ink-text-input";

interface InputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isLoading: boolean;
  agentName: string;
}

const AGENT_COLORS: Record<string, string> = {
  code: "cyan",
  plan: "yellow",
  review: "magenta",
};

export default function Input({
  value,
  onChange,
  onSubmit,
  isLoading,
  agentName,
}: InputProps) {
  const color = AGENT_COLORS[agentName] || "cyan";

  if (isLoading) {
    return (
      <Box paddingX={0}>
        <Text dimColor color={color}>❯ </Text>
        <Text dimColor italic>
          Press Esc to interrupt...
        </Text>
      </Box>
    );
  }

  return (
    <Box paddingX={0}>
      <Text bold color={color}>
        ❯{" "}
      </Text>
      <InkTextInput
        value={value}
        onChange={onChange}
        onSubmit={() => onSubmit()}
        placeholder={`Message ${agentName} agent...`}
        focus={!isLoading}
      />
    </Box>
  );
}
