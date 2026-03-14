// Input component (matches Claude Code's ❯ prompt)

import React from "react";
import { Box, Text } from "ink";
import InkTextInput from "ink-text-input";

interface InputProps {
  inputResetKey?: number;
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
  inputResetKey,
  value,
  onChange,
  onSubmit,
  isLoading,
  agentName,
}: InputProps) {
  const color = AGENT_COLORS[agentName] || "cyan";

  return (
    <Box flexDirection="column" paddingX={0}>
      <Box>
        <Text bold={!isLoading} dimColor={isLoading} color={color}>
          ❯{" "}
        </Text>
        <InkTextInput
          key={inputResetKey}
          value={value}
          onChange={onChange}
          onSubmit={() => onSubmit()}
          placeholder={isLoading ? "Type and press Enter to queue next message..." : 'Try "create a util logging.py that..."'}
          focus={true}
        />
      </Box>
      {isLoading && (
        <Text dimColor italic>
          Running response… press Esc to interrupt.
        </Text>
      )}
    </Box>
  );
}
