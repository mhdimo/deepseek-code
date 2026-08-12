// Divider — a horizontal divider line. Ported from
// claude-code-main/src/components/design-system/Divider.tsx. Stock Ink has no
// useTerminalSize hook and no <Ansi> component: terminal width comes from
// useStdout().stdout.columns (fallback 80) and titles render as plain text
// (stock Ink parses ANSI escape codes in text children automatically).

import React from "react";
import { Text, useStdout } from "ink";
import { getTheme, resolveColor } from "../../utils/theme.js";
import type { Theme } from "../../utils/theme.js";
import { useTheme } from "./ThemeProvider.js";

export type DividerProps = {
  /**
   * Width of the divider in characters.
   * Defaults to terminal width.
   */
  width?: number;

  /**
   * Theme color for the divider.
   * If not provided, dimColor is used.
   */
  color?: keyof Theme;

  /**
   * Character to use for the divider line.
   * @default '─'
   */
  char?: string;

  /**
   * Padding to subtract from the width (e.g., for indentation).
   * @default 0
   */
  padding?: number;

  /**
   * Title shown in the middle of the divider.
   * May contain ANSI codes (e.g., chalk-styled text).
   *
   * @example
   * // ─────────── Title ───────────
   * <Divider title="Title" />
   */
  title?: string;
};

/**
 * Minimal display-width estimate (wcwidth-lite). Box-drawing and block
 * elements are width 1; CJK and other wide ranges are width 2.
 */
function displayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0)!;
    if (code >= 0x2500 && code <= 0x259f) {
      width += 1; // box drawing / block elements — narrow in terminals
      continue;
    }
    const wide =
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK ... Yi
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK compat ideographs
      (code >= 0xfe30 && code <= 0xfe4f) || // CJK compat forms
      (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd); // Supplementary planes
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * A horizontal divider line.
 *
 * @example
 * // Full-width dimmed divider
 * <Divider />
 *
 * @example
 * // Colored divider
 * <Divider color="suggestion" />
 *
 * @example
 * // Fixed width
 * <Divider width={40} />
 *
 * @example
 * // Full width minus padding (for indented content)
 * <Divider padding={4} />
 *
 * @example
 * // With centered title
 * <Divider title="3 new messages" />
 */
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

  // `color` is a theme key — resolve it to a raw ink color (stock Ink does not
  // resolve theme keys itself).
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const resolvedColor = color ? resolveColor(theme[color]) : undefined;

  if (title) {
    const titleWidth = displayWidth(title) + 2; // +2 for spaces around title
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
