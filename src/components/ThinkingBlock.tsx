import React from "react";
import { Box, Text } from "ink";
import Markdown from "./Markdown.js";
import type { ContentSelection } from "./useMouseSelection.js";

/** The reference label is a constant (AssistantThinkingMessage.tsx): the
 *  collapsed block says "∴ Thinking", the expanded one adds an ellipsis.
 *  There is no elapsed time anywhere in it. */
const THINKING_LABEL = "∴ Thinking";

interface ThinkingBlockProps {
  content: string;
  isTranscriptMode?: boolean;
  /** Accepted for callers (MessageView passes the live flag); the label no
   *  longer varies with it. */
  isStreaming?: boolean;
  /** Content width in cols (used to wrap the transcript markdown). */
  width: number;
  /** Active selection (content coords) or null. */
  selection?: ContentSelection | null;
  /** Global content row where this block begins (label row). */
  startRow?: number;
  /** Accepted for callers; the reference shows no elapsed time, so these are
   *  no longer rendered. */
  thinkingStart?: number;
  thinkingEnd?: number;
}

export default function ThinkingBlock({
  content,
  isTranscriptMode,
  width,
  selection = null,
  startRow = 0,
}: ThinkingBlockProps) {
  if (isTranscriptMode) {
    return (
      <Box flexDirection="column" gap={1} width="100%">
        <Text dimColor italic>{`${THINKING_LABEL}…`}</Text>
        <Box paddingLeft={2}>
          <Markdown
            dim
            width={Math.max(1, width - 2)}
            selection={selection}
            startRow={startRow + 2}
            leftOffset={2}
          >
            {content}
          </Markdown>
        </Box>
      </Box>
    );
  }
  return (
    <Box>
      <Text dimColor italic>
        {THINKING_LABEL} <Text dimColor>(ctrl+o to expand)</Text>
      </Text>
    </Box>
  );
}
