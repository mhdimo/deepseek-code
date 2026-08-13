







import React, { createContext, useContext } from "react";
import { Box, Text } from "ink";

const MessageResponseContext = createContext(false);

interface MessageResponseProps {
  children: React.ReactNode;
}

export default function MessageResponse({ children }: MessageResponseProps) {
  const isNested = useContext(MessageResponseContext);

  
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
