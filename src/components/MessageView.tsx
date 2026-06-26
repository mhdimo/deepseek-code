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
  selectedToolCallId?: string | null;
  isTranscriptMode?: boolean;
}

export default function MessageView({ message, selectedToolCallId, isTranscriptMode }: MessageViewProps) {
  // ── User messages — dark grey background matching Claude Code ────────
  if (message.role === "user") {
    return (
      <Box
        flexDirection="column"
        marginTop={1}
        backgroundColor={theme.userMessageBg}
        paddingX={1}
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
            <Box flexDirection="column">
              {isTranscriptMode ? (
                <>
                  <Text dimColor italic>∴ Thought</Text>
                  <Text dimColor italic wrap="wrap">{message.thinking}</Text>
                </>
              ) : (
                <Text dimColor italic>∴ Thought (ctrl+o to expand)</Text>
              )}
            </Box>
          </MessageResponse>
        )}

        {/* Chronological message blocks */}
        {message.blocks && message.blocks.length > 0 ? (
          message.blocks.map((block, idx) => {
            if (block.type === "text" && block.content) {
              return (
                <MessageResponse key={`msg-block-${idx}`}>
                  {message.isError ? (
                    <Text color={theme.error} wrap="wrap">
                      {block.content}
                    </Text>
                  ) : (
                    <Markdown>{block.content}</Markdown>
                  )}
                </MessageResponse>
              );
            }
            if (block.type === "tool" && block.block) {
              return (
                <MessageResponse key={`msg-block-${idx}`}>
                  <ToolBlock
                    block={block.block}
                    isTranscriptMode={isTranscriptMode}
                    isHighlighted={
                      block.block.toolCallId
                        ? block.block.toolCallId === selectedToolCallId
                        : false
                    }
                  />
                </MessageResponse>
              );
            }
            return null;
          })
        ) : (
          <>
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
                <ToolBlock
                  block={tool}
                  isTranscriptMode={isTranscriptMode}
                  isHighlighted={tool.toolCallId ? tool.toolCallId === selectedToolCallId : false}
                />
              </MessageResponse>
            ))}
          </>
        )}
      </Box>
    );
  }

  return null;
}
