



import React from "react";
import { Text } from "ink";
import { theme, resolveColor } from "../utils/theme.js";


export function PressEnterToContinue(): React.ReactNode {
  return (
    <Text color={resolveColor(theme.permission)}>
      Press <Text bold>Enter</Text> to continue…
    </Text>
  );
}
