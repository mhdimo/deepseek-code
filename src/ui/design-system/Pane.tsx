








import React from "react";
import { Box } from "ink";
import type { Theme } from "../../utils/theme.js";
import { Divider } from "./Divider.js";

export type PaneProps = {
  children: React.ReactNode;
  
  color?: keyof Theme;
};


export function Pane({ children, color }: PaneProps): React.ReactNode {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Divider color={color} />
      <Box flexDirection="column" paddingX={2}>
        {children}
      </Box>
    </Box>
  );
}
