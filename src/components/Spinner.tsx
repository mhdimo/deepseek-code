// Blinking BLACK_CIRCLE loader matching Claude Code's <ToolUseLoader>
//
// Uses ⏺ (BLACK_CIRCLE) that blinks during loading — solid when done.
// This matches Claude Code's exact visual pattern.

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { theme } from "../utils/theme.js";

const BLACK_CIRCLE = "⏺";

interface SpinnerProps {
  label?: string;
}

export default function Spinner({ label }: SpinnerProps) {
  const [show, setShow] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => setShow((prev) => !prev), 300);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box minWidth={2}>
      <Text color={theme.assistant} dimColor>
        {show ? BLACK_CIRCLE : " "}
      </Text>
      {label && <Text dimColor> {label}</Text>}
    </Box>
  );
}
