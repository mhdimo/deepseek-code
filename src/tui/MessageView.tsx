// Message display component (matches Claude Code's message styling)

import React from "react";
import { Box, Text } from "ink";
import type { Message } from "../core/types.js";
import ToolBlock from "./ToolBlock.js";

interface MessageViewProps {
  message: Message;
}

export default function MessageView({ message }: MessageViewProps) {
  // User message — bold ❯ prefix
  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text bold color="white">❯ </Text>
          <Text wrap="wrap">{message.content}</Text>
        </Box>
      </Box>
    );
  }

  // Assistant message — thinking + tool blocks + text
  if (message.role === "assistant") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {/* Thinking / reasoning block (collapsed summary) */}
        {message.thinking && (
          <Box marginBottom={0}>
            <Text color="magenta" dimColor>
              💭 Thought for {Math.ceil(message.thinking.length / 100)}s
            </Text>
          </Box>
        )}

        {/* Message text */}
        {message.content && (
          <Box marginTop={message.toolUse?.length ? 0 : 0}>
            <Text
              color={message.isError ? "red" : undefined}
              wrap="wrap"
            >
              {message.content}
            </Text>
          </Box>
        )}

        {/* Tool use blocks (shown below the text) */}
        {message.toolUse?.map((tool, i) => (
          <ToolBlock key={tool.toolCallId || i} block={tool} />
        ))}
      </Box>
    );
  }

  // System messages — dim and italic
  if (message.role === "system") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor italic wrap="wrap">
          {message.content}
        </Text>
      </Box>
    );
  }

  return null;
}
