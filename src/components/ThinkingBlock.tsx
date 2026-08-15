import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Markdown from "./Markdown.js";
import type { ContentSelection } from "./useMouseSelection.js";

interface ThinkingBlockProps {
  content: string;
  isTranscriptMode?: boolean;
  isStreaming?: boolean;
  /** Content width in cols (used to wrap the transcript markdown). */
  width: number;
  /** Active selection (content coords) or null. */
  selection?: ContentSelection | null;
  /** Global content row where this block begins (label row). */
  startRow?: number;
  /** When the block's thinking started / ended (ms epoch) — the streaming
   *  label shows a live incrementing timer; finalized blocks show the total. */
  thinkingStart?: number;
  thinkingEnd?: number;
}

/** "42s" or "2m 03s" (thinking can run for minutes). */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export default function ThinkingBlock({
  content,
  isTranscriptMode,
  isStreaming,
  width,
  selection = null,
  startRow = 0,
  thinkingStart,
  thinkingEnd,
}: ThinkingBlockProps) {
  // Tick every second while thinking is streaming, so the timer increments
  // even when the engine is idle between reasoning deltas (no renders).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isStreaming || thinkingStart === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming, thinkingStart]);

  const hasElapsed = thinkingStart !== undefined;
  const elapsed =
    thinkingStart === undefined
      ? null
      : (isStreaming ? now : thinkingEnd ?? now) - thinkingStart;
  const timer = hasElapsed && elapsed !== null ? ` ${formatElapsed(elapsed)}` : "";

  const label = isStreaming ? `∴ Thinking…${timer}` : `∴ Thought${hasElapsed ? ` · ${formatElapsed(elapsed!)}` : ""}`;

  if (isTranscriptMode) {
    return (
      <Box flexDirection="column" gap={1} width="100%">
        <Text dimColor italic>{label}</Text>
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
        {label} <Text dimColor>(ctrl+o to expand)</Text>
      </Text>
    </Box>
  );
}
