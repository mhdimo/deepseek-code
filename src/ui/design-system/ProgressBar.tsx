




import React from "react";
import { Text } from "ink";
import { getTheme, resolveColor } from "../../utils/theme.js";
import type { Theme } from "../../utils/theme.js";
import { useTheme } from "./ThemeProvider.js";

export type ProgressBarProps = {
  
  ratio: number; 

  
  width: number; 

  
  fillColor?: keyof Theme;

  
  emptyColor?: keyof Theme;
};

const BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];


export function ProgressBar({
  ratio: inputRatio,
  width,
  fillColor,
  emptyColor,
}: ProgressBarProps): React.ReactNode {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  const ratio = Math.min(1, Math.max(0, inputRatio));
  const whole = Math.floor(ratio * width);

  const segments = [BLOCKS[BLOCKS.length - 1]!.repeat(whole)];
  if (whole < width) {
    const remainder = ratio * width - whole;
    const middle = Math.floor(remainder * BLOCKS.length);
    segments.push(BLOCKS[middle]!);

    const empty = width - whole - 1;
    if (empty > 0) {
      segments.push(BLOCKS[0]!.repeat(empty));
    }
  }

  return (
    <Text
      color={fillColor ? resolveColor(theme[fillColor]!) : undefined}
      backgroundColor={emptyColor ? resolveColor(theme[emptyColor]!) : undefined}
    >
      {segments.join("")}
    </Text>
  );
}
