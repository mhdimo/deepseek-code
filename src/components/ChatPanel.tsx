





import React from "react";
import { Box } from "ink";
import { basename } from "node:path";
import type { Message, ToolUseBlock, MessageBlock } from "../types/index.js";
import MessageView from "./MessageView.js";
import Spinner from "./Spinner.js";
import WelcomeScreen from "./WelcomeScreen.js";
import { buildStreamingAssistantMessage } from "./streamingMessage.js";


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
  const streamingMessage = isLoading
    ? buildStreamingAssistantMessage(streamingBlocks, streamingText, streamingToolUse)
    : null;
  const visibleMessages = streamingMessage ? [...messages, streamingMessage] : messages;

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
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
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        {visibleMessages.map((m, idx) => (
          <MessageView
            key={streamingMessage === m ? "streaming-assistant" : `msg-${m.timestamp}-${idx}`}
            message={m}
            selectedToolCallId={selectedToolCallId}
            isTranscriptMode={isTranscriptMode}
            isStreaming={streamingMessage === m}
          />
        ))}
        {isLoading && !streamingMessage && (
          <Box marginTop={1}>
            <Spinner noun={basename(workingDirectory)} sentiment={sentiment} />
          </Box>
        )}
      </Box>
    </Box>
  );
});
