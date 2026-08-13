















import React from "react";
import { Box, Text } from "ink";
import type { Message, MessageBlock } from "../types/index.js";
import { theme, resolveColor } from "../utils/theme.js";
import Markdown from "./Markdown.js";
import ToolBlock from "./ToolBlock.js";
import MessageResponse from "./MessageResponse.js";
import ThinkingBlock from "./ThinkingBlock.js";
import { BLACK_CIRCLE } from "./ToolBlock.js";


interface MessageViewProps {
  message: Message;
  selectedToolCallId?: string | null;
  isTranscriptMode?: boolean;
}


function TextBlock({ content, isError, dim }: { content: string; isError?: boolean; dim?: boolean }): React.ReactElement {
  if (isError) {
    
    return (
      <MessageResponse>
        <Text color={resolveColor(theme.error)} wrap="wrap">
          {content}
        </Text>
      </MessageResponse>
    );
  }
  return (
    <Box alignItems="flex-start" flexDirection="row">
      <Box minWidth={2} flexShrink={0}>
        <Text color={resolveColor(theme.text)}>{BLACK_CIRCLE}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown dim={dim}>{content}</Markdown>
      </Box>
    </Box>
  );
}

function MessageView({ message, selectedToolCallId, isTranscriptMode }: MessageViewProps) {
  
  
  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text wrap="wrap">{message.content}</Text>
      </Box>
    );
  }

  
  if (message.role === "system") {
    return (
      <Box flexDirection="column">
        <Text dimColor italic wrap="wrap">
          {message.content}
        </Text>
      </Box>
    );
  }

  
  if (message.role === "assistant") {
    const renderBlock = (block: MessageBlock, idx: number, first: boolean): React.ReactNode => {
      const marginTop = first ? 1 : 0;
      if (block.type === "text" && block.content) {
        return (
          <Box key={`msg-block-${idx}`} marginTop={marginTop}>
            <TextBlock content={block.content} isError={message.isError} />
          </Box>
        );
      }
      if (block.type === "tool" && block.block) {
        return (
          <Box key={`msg-block-${idx}`} marginTop={marginTop}>
            <ToolBlock
              block={block.block}
              isTranscriptMode={isTranscriptMode}
              isHighlighted={
                block.block.toolCallId
                  ? block.block.toolCallId === selectedToolCallId
                  : false
              }
            />
          </Box>
        );
      }
      if (block.type === "thinking") {
        return (
          <Box key={`msg-block-${idx}`} marginTop={marginTop}>
            <ThinkingBlock
              content={block.content || ""}
              isTranscriptMode={isTranscriptMode}
            />
          </Box>
        );
      }
      return null;
    };

    return (
      <Box flexDirection="column">
        {}
        {message.thinking && (
          <Box marginTop={1}>
            <ThinkingBlock content={message.thinking} isTranscriptMode={isTranscriptMode} />
          </Box>
        )}

        {}
        {message.blocks && message.blocks.length > 0 ? (
          message.blocks.map((block, idx) => renderBlock(block, idx, idx === 0 && !message.thinking))
        ) : (
          <>
            {}
            {message.content && (
              <Box marginTop={1}>
                <TextBlock content={message.content} isError={message.isError} />
              </Box>
            )}

            {}
            {message.toolUse?.map((tool, i) => (
              <Box key={tool.toolCallId || i} marginTop={i === 0 ? 1 : 0}>
                <ToolBlock
                  block={tool}
                  isTranscriptMode={isTranscriptMode}
                  isHighlighted={tool.toolCallId ? tool.toolCallId === selectedToolCallId : false}
                />
              </Box>
            ))}
          </>
        )}
      </Box>
    );
  }

  return null;
}

export default React.memo(MessageView);
