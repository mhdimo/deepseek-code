





import React from "react";
import { Box, Text } from "ink";
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
  
  freezeWelcome?: boolean;
}






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
  freezeWelcome = false,
  isTranscriptMode = false,
}: ChatPanelProps) {
  
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const hasBadWord = lastUserMessage
    ? /\b(fuck|shit|bitch|asshole|bastard|damn|crap|cunt|dick|piss|bollocks|bugger|ass)\b/i.test(lastUserMessage.content)
    : false;
  const sentiment = hasBadWord ? "frustrated" : "neutral";

  return (
    <Box flexDirection="column" flexGrow={1}>
      {}
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
            frozen={freezeWelcome}
          />
        </Box>
      )}

      {}
      {}
      <Box flexDirection="column">
        {messages.map((m, idx) => (
          <MessageView
            key={`msg-${m.timestamp}-${idx}`}
            message={m}
            selectedToolCallId={selectedToolCallId}
            isTranscriptMode={isTranscriptMode}
          />
        ))}
      </Box>

      {}
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
              {}
              {streamingToolUse.map((tool, i) => (
                <Box key={tool.toolCallId || i} marginTop={1}>
                  <ToolBlock block={tool} isTranscriptMode={isTranscriptMode} />
                </Box>
              ))}

              {}
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
