// Chat panel — renders welcome screen + scrolling messages + streaming state

import React from "react";
import { Box, Static, Text } from "ink";
import type { Message, ToolUseBlock, MessageBlock } from "../types/index.js";
import MessageView from "./MessageView.js";
import ToolBlock from "./ToolBlock.js";
import Markdown from "./Markdown.js";
import Spinner from "./Spinner.js";
import WelcomeScreen from "./WelcomeScreen.js";
import MessageResponse from "./MessageResponse.js";
import { theme } from "../utils/theme.js";

interface ChatPanelProps {
  messages: Message[];
  isLoading: boolean;
  streamingText: string;
  streamingThinking: string;
  streamingToolUse: ToolUseBlock[];
  version: string;
  model: string;
  workingDirectory: string;
  agentName: string;
  providerType: string;
  baseURL?: string;
  hasApiKey?: boolean;
  selectedToolCallId?: string | null;
  streamingBlocks?: MessageBlock[];
  isTranscriptMode?: boolean;
}

type StaticItem =
  | { type: "message"; key: string; message: Message };

export default function ChatPanel({
  messages,
  isLoading,
  streamingText,
  streamingThinking,
  streamingToolUse,
  version,
  model,
  workingDirectory,
  agentName,
  providerType,
  baseURL,
  hasApiKey = true,
  selectedToolCallId = null,
  streamingBlocks = [],
  isTranscriptMode = false,
}: ChatPanelProps) {
  // Build static items: welcome screen + finalized messages
  const items: StaticItem[] = [
    ...messages.map((m, i) => ({
      type: "message" as const,
      key: `msg-${m.timestamp}-${i}`,
      message: m,
    })),
  ];

  // Sentiment detection based on last user message
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const hasBadWord = lastUserMessage
    ? /\b(fuck|shit|bitch|asshole|bastard|damn|crap|cunt|dick|piss|bollocks|bugger|ass)\b/i.test(lastUserMessage.content)
    : false;
  const sentiment = hasBadWord ? "frustrated" : "neutral";

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Welcome screen (only show when no messages) */}
      {messages.length === 0 && (
        <Box marginBottom={1}>
          <WelcomeScreen
            version={version}
            model={model}
            workingDirectory={workingDirectory}
            agentName={agentName}
            providerType={providerType}
            baseURL={baseURL}
            hasApiKey={hasApiKey}
          />
        </Box>
      )}

      {/* If transcript mode is active, render everything in a normal Box to force complete re-rendering and expansion to stdout. Otherwise, use Static to preserve terminal scrollback. */}
      {isTranscriptMode ? (
        <Box flexDirection="column">
          {messages.map((m, i) => (
            <Box key={`transcript-msg-${m.timestamp}-${i}`}>
              <MessageView
                message={m}
                selectedToolCallId={selectedToolCallId}
                isTranscriptMode={isTranscriptMode}
              />
            </Box>
          ))}
        </Box>
      ) : (
        /* Static items */
        <Static items={items}>
          {(item) => {
            return (
              <Box key={item.key}>
                <MessageView
                  message={item.message}
                  selectedToolCallId={selectedToolCallId}
                  isTranscriptMode={isTranscriptMode}
                />
              </Box>
            );
          }}
        </Static>
      )}

      {/* Live streaming output (not yet finalized) */}
      {isLoading && (
        <Box flexDirection="column">
          {/* Streaming thinking (reasoning) — ∴ therefore sign matching Claude Code */}
          {streamingThinking ? (
            <MessageResponse>
              <Box flexDirection="column">
                <Text dimColor italic>
                  ∴ Thinking
                </Text>
                <Box marginLeft={2}>
                  <Text dimColor wrap="wrap">
                    {streamingThinking.length > 200
                      ? "…" + streamingThinking.slice(-200)
                      : streamingThinking}
                  </Text>
                </Box>
              </Box>
            </MessageResponse>
          ) : null}

          {streamingBlocks && streamingBlocks.length > 0 ? (
            streamingBlocks.map((block, idx) => {
              const isLast = idx === streamingBlocks.length - 1;
              if (block.type === "text" && block.content) {
                return (
                  <MessageResponse key={`stream-block-${idx}`}>
                    <Box flexDirection="column">
                      <Markdown>{block.content}</Markdown>
                      {isLast && (
                        <Box>
                          <Text color={theme.assistant}>▊</Text>
                        </Box>
                      )}
                    </Box>
                  </MessageResponse>
                );
              }
              if (block.type === "tool" && block.block) {
                return (
                  <MessageResponse key={`stream-block-${idx}`}>
                    <ToolBlock block={block.block} isTranscriptMode={isTranscriptMode} />
                  </MessageResponse>
                );
              }
              return null;
            })
          ) : (
            <>
              {/* Streaming tool blocks */}
              {streamingToolUse.map((tool, i) => (
                <MessageResponse key={tool.toolCallId || i}>
                  <ToolBlock block={tool} isTranscriptMode={isTranscriptMode} />
                </MessageResponse>
              ))}

              {/* Streaming text */}
              {streamingText ? (
                <MessageResponse>
                  <Box flexDirection="column">
                    <Markdown>{streamingText}</Markdown>
                    <Box>
                      <Text color={theme.assistant}>▊</Text>
                    </Box>
                  </Box>
                </MessageResponse>
              ) : (
                !streamingToolUse.some((t) => t.status === "running") && (
                  <MessageResponse>
                    <Spinner label="Thinking..." sentiment={sentiment} />
                  </MessageResponse>
                )
              )}
            </>
          )}
        </Box>
      )}
    </Box>
  );
}
