// Message display — matches Claude Code's exact layout
//
// Layout:
// User message text on dark grey background (userMessageBackground)
//
//   ⎿ Assistant response with **markdown**.            ← rendered markdown
//
//   ⎿ Read(file_path: "src/App.tsx")                ← tool block inline
//     ✓ 42 lines (1.2s)
//
//   ⎿ More assistant text...
//
//   ⎿ ∴ Thinking                                 ← dim italic thinking

import React from "react";
import { Box, Text } from "ink";
import type { Message } from "../types/index.js";
import Markdown from "./Markdown.js";
import ToolBlock from "./ToolBlock.js";
import MessageResponse from "./MessageResponse.js";
import { theme } from "../utils/theme.js";

interface MessageViewProps {
  message: Message;
}

export default function MessageView({ message }: MessageViewProps) {
  // ── User messages — dark grey background matching Claude Code ────────
  if (message.role === "user") {
    return (
      <Box
        flexDirection="column"
        marginTop={1}
        backgroundColor={theme.userMessageBg}
        paddingRight={1}
      >
        <Text wrap="wrap">{message.content}</Text>
      </Box>
    );
  }

  // ── System messages ───────────────────────────────────────────────────
  if (message.role === "system") {
    return (
      <Box flexDirection="column">
        <Text dimColor italic wrap="wrap">
          {message.content}
        </Text>
      </Box>
    );
  }

  // ── Assistant messages — wrapped in MessageResponse (⎿ border) ──────
  if (message.role === "assistant") {
    return (
      <Box flexDirection="column">
        {/* Thinking indicator — therefore sign matching Claude Code */}
        {message.thinking && (
          <MessageResponse>
            <Text dimColor italic>
              ∴ Thinking
            </Text>
          </MessageResponse>
        )}

        {/* Text content — rendered as Markdown inside MessageResponse */}
        {message.content && (
          <MessageResponse>
            {message.isError ? (
              <Text color={theme.error} wrap="wrap">
                {message.content}
              </Text>
            ) : (
              <Markdown>{message.content}</Markdown>
            )}
          </MessageResponse>
        )}

        {/* Tool blocks inline */}
        {message.toolUse?.map((tool, i) => (
          <MessageResponse key={tool.toolCallId || i}>
            <ToolBlock block={tool} />
          </MessageResponse>
        ))}
      </Box>
    );
  }

  return null;
}
