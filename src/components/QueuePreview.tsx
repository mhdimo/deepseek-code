import React from "react";
import { Box, Text } from "ink";
import { theme, resolveColor } from "../utils/theme.js";

interface QueuePreviewProps {
  queueItems: string[];
}

/**
 * Queued submissions render as the user prompts they will become: one
 * full-width `❯ <message>` row per item, indented two columns, on the
 * user-message band — no count, no "▸" bullet, no truncation.
 */
export default function QueuePreview({ queueItems }: QueuePreviewProps) {
  if (queueItems.length === 0) return null;

  return (
    <Box marginTop={1} flexDirection="column" paddingX={2}>
      {queueItems.map((item, i) => (
        <Box
          key={i}
          backgroundColor={resolveColor(theme.userMessageBackground)}
          paddingRight={1}
        >
          <Text>
            <Text color={resolveColor(theme.subtle)}>{"❯ "}</Text>
            <Text color={resolveColor(theme.text)}>{item}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}
