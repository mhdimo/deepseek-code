// ThemedBox — theme-aware Box component that resolves theme color keys to raw
// colors for border/background props. Ported from
// claude-code-main/src/components/design-system/ThemedBox.tsx. Stock Ink 6
// has no click/focus/keyboard event props (those were fork-only), so those
// are trimmed from the exported Props.

import React from "react";
import { Box, type BoxProps } from "ink";
import type { DOMElement } from "ink";
import { getTheme, resolveColor, type Theme } from "../../utils/theme.js";
import { useTheme } from "./ThemeProvider.js";

// Color props that accept theme keys
type ThemedColorProps = {
  readonly borderColor?: keyof Theme | string;
  readonly borderTopColor?: keyof Theme | string;
  readonly borderBottomColor?: keyof Theme | string;
  readonly borderLeftColor?: keyof Theme | string;
  readonly borderRightColor?: keyof Theme | string;
  readonly backgroundColor?: keyof Theme | string;
};

type BoxColorPropNames =
  | "borderColor"
  | "borderTopColor"
  | "borderBottomColor"
  | "borderLeftColor"
  | "borderRightColor"
  | "backgroundColor";

// Base Box props (styles, ref, aria, children) without the color props
// (they'll be overridden with theme-key support). Ink's exported BoxProps
// omits children/ref — they live on the component type, so add them back.
export type Props = Omit<BoxProps, BoxColorPropNames> &
  ThemedColorProps & {
    children?: React.ReactNode;
    ref?: React.Ref<DOMElement>;
  };

const RAW_COLOR_PREFIXES = ["rgb(", "#", "ansi256(", "ansi:"];

/** True when the value is already a raw ink/chalk color, not a theme key. */
function isRawColor(value: string): boolean {
  return RAW_COLOR_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Resolves a color value that may be a theme key to a raw ink color string.
 */
function resolveColorValue(color: keyof Theme | string | undefined, theme: Theme): string | undefined {
  if (!color) return undefined;
  // Check if it's a raw color (starts with rgb(, #, ansi256(, or ansi:)
  if (isRawColor(color)) {
    return resolveColor(color);
  }
  // It's a theme key - resolve it
  const resolved = theme[color as keyof Theme];
  return resolved === undefined ? undefined : resolveColor(resolved);
}

/**
 * Theme-aware Box component that resolves theme color keys to raw colors.
 * This wraps the base Ink Box component with theme resolution for border and
 * background colors.
 */
export default function ThemedBox({
  borderColor,
  borderTopColor,
  borderBottomColor,
  borderLeftColor,
  borderRightColor,
  backgroundColor,
  children,
  ref,
  ...rest
}: Props): React.ReactNode {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  // Resolve theme keys to raw colors
  const resolvedBorderColor = resolveColorValue(borderColor, theme);
  const resolvedBorderTopColor = resolveColorValue(borderTopColor, theme);
  const resolvedBorderBottomColor = resolveColorValue(borderBottomColor, theme);
  const resolvedBorderLeftColor = resolveColorValue(borderLeftColor, theme);
  const resolvedBorderRightColor = resolveColorValue(borderRightColor, theme);
  const resolvedBackgroundColor = resolveColorValue(backgroundColor, theme);

  return (
    <Box
      ref={ref}
      borderColor={resolvedBorderColor}
      borderTopColor={resolvedBorderTopColor}
      borderBottomColor={resolvedBorderBottomColor}
      borderLeftColor={resolvedBorderLeftColor}
      borderRightColor={resolvedBorderRightColor}
      backgroundColor={resolvedBackgroundColor}
      {...rest}
    >
      {children}
    </Box>
  );
}
