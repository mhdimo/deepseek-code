import React from "react";
import { Box, Text } from "ink";

interface QueuePreviewProps {
  queueItems: string[];
}

const PREVIEW_MAX = 60;

export default function QueuePreview({ queueItems }: QueuePreviewProps) {
  if (queueItems.length === 0) return null;

  const first = queueItems[0]!;
  const preview =
    first.length > PREVIEW_MAX
      ? first.slice(0, PREVIEW_MAX - 1) + "…"
      : first;
  const remaining = queueItems.length - 1;

  return (
    <Box paddingX={0}>
      <Text>
        <Text color="yellow" bold>
          {"📋 "}{queueItems.length} queued
        </Text>
        <Text dimColor>
          {" · ▸ "}
          {preview}
          {remaining > 0 ? ` · +${remaining} more` : ""}
          {" · "}
          <Text bold>Ctrl+Q</Text> clear
        </Text>
      </Text>
    </Box>
  );
}
