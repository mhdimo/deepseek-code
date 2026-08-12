// Thinking block — extended reasoning, rendered collapsed by default like
// Claude Code ("∴ Thought (ctrl+o to expand)"), full text in transcript mode.
// Rendered chronologically inside a message's block stream, never hoisted.
//
// Styling ported from claude-code's AssistantThinkingMessage (dim italic
// '∴ Thinking' label; full content is dim markdown with a 2-col left pad in
// transcript/verbose mode). DeepSeek additions on top of the reference: a
// flattened 140-char preview under the collapsed label, and the streaming
// '∴ Thinking…' variant while the model is still producing the block.

import React from "react";
import { Box, Text } from "ink";
import Markdown from "./Markdown.js";

interface ThinkingBlockProps {
  content: string;
  isTranscriptMode?: boolean;
  /** True while the model is still producing this reasoning block. */
  isStreaming?: boolean;
}

const PREVIEW_LIMIT = 140;

/** First line of the thinking, whitespace-flattened, for the collapsed preview. */
function previewOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_LIMIT) return flat;
  return flat.slice(0, PREVIEW_LIMIT) + "…";
}

export default function ThinkingBlock({ content, isTranscriptMode, isStreaming }: ThinkingBlockProps) {
  if (isTranscriptMode) {
    // Claude Code's full-thinking view: '∴ Thinking…' + dim markdown, 2-col pad
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
