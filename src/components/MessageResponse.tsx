// MessageResponse — ⎿ left border wrapper matching Claude Code's <MessageResponse>
//
// Renders a dimmed ⎿ character to the left of all assistant message content,
// creating the distinctive left-border visual that separates Claude Code's
// assistant responses from user messages.
//
// Nested MessageResponse components avoid duplicate ⎿ characters.

import React, { createContext, useContext } from "react";
import { Box, Text } from "ink";

const MessageResponseContext = createContext(false);

interface MessageResponseProps {
  children: React.ReactNode;
}

export default function MessageResponse({ children }: MessageResponseProps) {
  const isNested = useContext(MessageResponseContext);

  // Avoid duplicate ⎿ characters in nested contexts
  if (isNested) return <>{children}</>;

  return (
    <MessageResponseContext.Provider value={true}>
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text dimColor>{"  "}⎿  </Text>
        </Box>
        <Box flexShrink={1} flexGrow={1}>
          {children}
        </Box>
      </Box>
    </MessageResponseContext.Provider>
  );
}
