// Chat panel — renders welcome screen + scrolling messages + streaming state.
//
// Layout ported from Claude Code's Messages.tsx: assistant text streams under
// a ⏺ dot, thinking blocks collapse to '∴ Thinking…', tool calls render with
// their status dot; consecutive blocks stack without extra margins.

import React from "react";
import { Box, Static, Text } from "ink";
import { basename } from "node:path";
import type { Message, ToolUseBlock, MessageBlock } from "../types/index.js";
import { theme, resolveColor } from "../utils/theme.js";
import MessageView from "./MessageView.js";
import ToolBlock from "./ToolBlock.js";
import Markdown from "./Markdown.js";
import Spinner from "./Spinner.js";
import WelcomeScreen from "./WelcomeScreen.js";
import ThinkingBlock from "./ThinkingBlock.js";
import { BLACK_CIRCLE } from "./ToolBlock.js";


interface ChatPanelProps {
  messages: Message[];
  isLoading: boolean;
  streamingText: string;
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

// Old messages render via <Static> (written once to scrollback). Only the last
// RECENT_RENDERED messages live in a re-rendering Box so tool blocks there can
// expand/collapse. Bounding the live region keeps streaming re-renders cheap
// and prevents Ink from choking when the transcript is taller than the terminal.
const RECENT_RENDERED = 12;

/** Live streaming text: ⏺ + markdown + teal cursor block (Claude Code's
 *  streamingText layout with DeepSeek's ▊ typing cursor). */
function StreamingText({ text }: { text: string }): React.ReactElement {
  return (
    <Box alignItems="flex-start" flexDirection="row" marginTop={1}>
      <Box minWidth={2} flexShrink={0}>
        <Text color={resolveColor(theme.text)}>{BLACK_CIRCLE}</Text>
      </Box>
      <Box flexDirection="column">
        <Markdown>{text}</Markdown>
        <Box>
          <Text color={resolveColor(theme.claude)}>▊</Text>
        </Box>
      </Box>
    </Box>
  );
}

export default React.memo(function ChatPanel({
  messages,
  isLoading,
  streamingText,
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

      {/* Old messages → <Static> (rendered once into scrollback). Recent ones →
          a re-rendering Box so their tool blocks can expand/collapse. */}
      {(() => {
        const splitAt = Math.max(0, messages.length - RECENT_RENDERED);
        const oldItems = messages.slice(0, splitAt).map((m, i) => ({
          key: `msg-${m.timestamp}-${i}`,
          message: m,
        }));
        return (
          <>
            <Static items={oldItems}>
              {(item) => (
                <MessageView
                  key={item.key}
                  message={item.message}
                  selectedToolCallId={selectedToolCallId}
                  isTranscriptMode={isTranscriptMode}
                />
              )}
            </Static>
            <Box flexDirection="column">
              {messages.slice(splitAt).map((m, idx) => (
                <MessageView
                  key={`msg-${m.timestamp}-${splitAt + idx}`}
                  message={m}
                  selectedToolCallId={selectedToolCallId}
                  isTranscriptMode={isTranscriptMode}
                />
              ))}
            </Box>
          </>
        );
      })()}

      {/* Live streaming output (not yet finalized) */}
      {isLoading && (
        <Box flexDirection="column">
          {streamingBlocks && streamingBlocks.length > 0 ? (
            streamingBlocks.map((block, idx) => {
              const isLast = idx === streamingBlocks.length - 1;
              if (block.type === "text" && block.content) {
                return <StreamingText key={`stream-block-${idx}`} text={block.content} />;
              }
              if (block.type === "tool" && block.block) {
                return (
                  <Box key={`stream-block-${idx}`} marginTop={1}>
                    <ToolBlock block={block.block} isTranscriptMode={isTranscriptMode} />
                  </Box>
                );
              }
              if (block.type === "thinking") {
                return (
                  <Box key={`stream-block-${idx}`} marginTop={1}>
                    <ThinkingBlock
                      content={block.content || ""}
                      isTranscriptMode={isTranscriptMode}
                      isStreaming={isLast}
                    />
                  </Box>
                );
              }
              return null;
            })
          ) : (
            <>
              {/* Streaming tool blocks */}
              {streamingToolUse.map((tool, i) => (
                <Box key={tool.toolCallId || i} marginTop={1}>
                  <ToolBlock block={tool} isTranscriptMode={isTranscriptMode} />
                </Box>
              ))}

              {/* Streaming text */}
              {streamingText ? (
                <StreamingText text={streamingText} />
              ) : (
                !streamingToolUse.some((t) => t.status === "running") && (
                  <Box marginTop={1}>
                    <Spinner noun={basename(workingDirectory)} sentiment={sentiment} />
                  </Box>
                )
              )}
            </>
          )}
        </Box>
      )}
    </Box>
  );
});
