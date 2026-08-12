// ProgressBar — a character-based progress bar. Ported from
// claude-code-main/src/components/design-system/ProgressBar.tsx (fork-ink
// import translated to stock 'ink'; theme keys resolve via
// getTheme()/resolveColor).

import React from "react";
import { Text } from "ink";
import { getTheme, resolveColor } from "../../utils/theme.js";
import type { Theme } from "../../utils/theme.js";
import { useTheme } from "./ThemeProvider.js";

export type ProgressBarProps = {
  /**
   * How much progress to display, between 0 and 1 inclusive
   */
  ratio: number; // [0, 1]

  /**
   * How many characters wide to draw the progress bar
   */
  width: number; // how many characters wide

  /**
   * Optional color for the filled portion of the bar
   */
  fillColor?: keyof Theme;

  /**
   * Optional color for the empty portion of the bar
   */
  emptyColor?: keyof Theme;
};

const BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

/**
 * Renders a progress bar with partial-block precision.
 *
 * @example
 * <ProgressBar ratio={0.7} width={20} />
 */
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
      color={fillColor ? resolveColor(theme[fillColor]) : undefined}
      backgroundColor={emptyColor ? resolveColor(theme[emptyColor]) : undefined}
    >
      {segments.join("")}
    </Text>
  );
}
