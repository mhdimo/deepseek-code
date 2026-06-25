// Chat panel — renders welcome screen + scrolling messages + streaming state

import React from "react";
import { Box, Static, Text } from "ink";
import type { Message, ToolUseBlock } from "../types/index.js";
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
}: ChatPanelProps) {
  // Build static items: welcome screen + finalized messages
  const items: StaticItem[] = [
    ...messages.map((m, i) => ({
      type: "message" as const,
      key: `msg-${m.timestamp}-${i}`,
      message: m,
    })),
  ];

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

      {/* Static items */}
      <Static items={items}>
        {(item) => {
          return (
            <Box key={item.key}>
              <MessageView message={item.message} selectedToolCallId={selectedToolCallId} />
            </Box>
          );
        }}
      </Static>

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

          {/* Streaming tool blocks */}
          {streamingToolUse.map((tool, i) => (
            <MessageResponse key={tool.toolCallId || i}>
              <ToolBlock block={tool} />
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
                <Spinner label="Thinking..." />
              </MessageResponse>
            )
          )}
        </Box>
      )}
    </Box>
  );
}
