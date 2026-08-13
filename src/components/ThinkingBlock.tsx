









import React from "react";
import { Box, Text } from "ink";
import Markdown from "./Markdown.js";

interface ThinkingBlockProps {
  content: string;
  isTranscriptMode?: boolean;
  
  isStreaming?: boolean;
}

const PREVIEW_LIMIT = 140;


function previewOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_LIMIT) return flat;
  return flat.slice(0, PREVIEW_LIMIT) + "…";
}

export default function ThinkingBlock({ content, isTranscriptMode, isStreaming }: ThinkingBlockProps) {
  if (isTranscriptMode) {
    
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor italic>
          ∴ Thought
        </Text>
        <Box paddingLeft={2}>
          <Markdown dim>{content}</Markdown>
        </Box>
      </Box>
    );
  }

  const preview = previewOf(content);
  return (
    <Box flexDirection="column">
      <Text dimColor italic>
        {isStreaming ? "∴ Thinking…" : "∴ Thought (ctrl+o to expand)"}
      </Text>
      {preview ? (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">
            {preview}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
