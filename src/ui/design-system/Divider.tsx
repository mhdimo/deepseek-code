





import React from "react";
import { Text, useStdout } from "ink";
import { getTheme, resolveColor } from "../../utils/theme.js";
import type { Theme } from "../../utils/theme.js";
import { useTheme } from "./ThemeProvider.js";

export type DividerProps = {
  
  width?: number;

  
  color?: keyof Theme;

  
  char?: string;

  
  padding?: number;

  
  title?: string;
};


function displayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0)!;
    if (code >= 0x2500 && code <= 0x259f) {
      width += 1; 
      continue;
    }
    const wide =
      (code >= 0x1100 && code <= 0x115f) || 
      (code >= 0x2e80 && code <= 0xa4cf) || 
      (code >= 0xac00 && code <= 0xd7a3) || 
      (code >= 0xf900 && code <= 0xfaff) || 
      (code >= 0xfe30 && code <= 0xfe4f) || 
      (code >= 0xff00 && code <= 0xff60) || 
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd); 
    width += wide ? 2 : 1;
  }
  return width;
}


export function Divider({
  width,
  color,
  char = "─",
  padding = 0,
  title,
}: DividerProps): React.ReactNode {
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns ?? 80;
  const effectiveWidth = Math.max(0, (width ?? terminalWidth) - padding);

  
  
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const resolvedColor = color ? resolveColor(theme[color]!) : undefined;

  if (title) {
    const titleWidth = displayWidth(title) + 2; 
    const sideWidth = Math.max(0, effectiveWidth - titleWidth);
    const leftWidth = Math.floor(sideWidth / 2);
    const rightWidth = sideWidth - leftWidth;
    return (
      <Text color={resolvedColor} dimColor={!color}>
        {char.repeat(leftWidth)}{" "}
        <Text dimColor>{title}</Text>{" "}
        {char.repeat(rightWidth)}
      </Text>
    );
  }

  return (
    <Text color={resolvedColor} dimColor={!color}>
      {char.repeat(effectiveWidth)}
    </Text>
  );
}
