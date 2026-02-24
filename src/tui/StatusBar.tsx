// Status bar (matches Claude Code's bottom status line)

import React from "react";
import { Box, Text } from "ink";
import type { AgentName } from "../core/types.js";

interface StatusBarProps {
  model: string;
  agentName: AgentName;
  tokenCount?: number;
  cost?: number;
  thinkingEnabled?: boolean;
}

const AGENT_COLORS: Record<string, string> = {
  code: "cyan",
  plan: "yellow",
  review: "magenta",
};

export default function StatusBar({
  model,
  agentName,
  tokenCount = 0,
  cost = 0,
  thinkingEnabled = false,
}: StatusBarProps) {
  const cols = process.stdout.columns || 80;
  const separator = "─".repeat(cols);
  const agentColor = AGENT_COLORS[agentName] || "cyan";

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{separator}</Text>
      </Box>

      <Box justifyContent="space-between" paddingX={0}>
        {/* Left side: agent + model + tokens + cost */}
        <Box>
          <Text color={agentColor} bold>
            [{agentName}]
          </Text>
          <Text dimColor> {model}</Text>
          {tokenCount > 0 && (
            <>
              <Text dimColor> · </Text>
              <Text dimColor>
                {tokenCount > 1000
                  ? `${(tokenCount / 1000).toFixed(1)}k`
                  : tokenCount}{" "}
                tokens
              </Text>
            </>
          )}
          {cost > 0 && (
            <>
              <Text dimColor> · </Text>
              <Text dimColor>${cost.toFixed(4)}</Text>
            </>
          )}
          {thinkingEnabled && (
            <>
              <Text dimColor> · </Text>
              <Text color="magenta">💭</Text>
            </>
          )}
        </Box>

        {/* Right side: shortcuts */}
        <Box>
          <Text dimColor>
            Shift+Tab thinking · /help for commands
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
