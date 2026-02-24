// Chat panel — renders welcome screen + scrolling messages + streaming state

import React from "react";
import { Box, Static, Text } from "ink";
import type { Message, ToolUseBlock } from "../core/types.js";
import MessageView from "./MessageView.js";
import ToolBlock from "./ToolBlock.js";
import Spinner from "./Spinner.js";
import WelcomeScreen from "./WelcomeScreen.js";

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
}

type StaticItem =
  | { type: "welcome"; key: string }
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
}: ChatPanelProps) {
  // Build static items: welcome screen + finalized messages
  const items: StaticItem[] = [
    { type: "welcome", key: "welcome" },
    ...messages.map((m, i) => ({
      type: "message" as const,
      key: `msg-${m.timestamp}-${i}`,
      message: m,
    })),
  ];

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Static items */}
      <Static items={items}>
        {(item) => {
          if (item.type === "welcome") {
            return (
              <Box key={item.key} marginBottom={1}>
                <WelcomeScreen
                  version={version}
                  model={model}
                  workingDirectory={workingDirectory}
                  agentName={agentName}
                  providerType={providerType}
                  baseURL={baseURL}
                />
              </Box>
            );
          }
          return (
            <Box key={item.key}>
              <MessageView message={item.message} />
            </Box>
          );
        }}
      </Static>

      {/* Live streaming output (not yet finalized) */}
      {isLoading && (
        <Box flexDirection="column">
          {/* Streaming thinking (reasoning) */}
          {streamingThinking ? (
            <Box flexDirection="column" marginBottom={1}>
              <Text color="magenta" dimColor>💭 Thinking…</Text>
              <Box marginLeft={2}>
                <Text dimColor wrap="wrap">
                  {streamingThinking.length > 200
                    ? "…" + streamingThinking.slice(-200)
                    : streamingThinking}
                </Text>
              </Box>
            </Box>
          ) : null}

          {/* Streaming tool blocks */}
          {streamingToolUse.map((tool, i) => (
            <ToolBlock key={tool.toolCallId || i} block={tool} />
          ))}

          {/* Streaming text */}
          {streamingText ? (
            <Box>
              <Text wrap="wrap">{streamingText}</Text>
              <Text color="cyan">▊</Text>
            </Box>
          ) : (
            !streamingToolUse.some((t) => t.status === "running") && (
              <Spinner label="Thinking..." />
            )
          )}
        </Box>
      )}
    </Box>
  );
}
