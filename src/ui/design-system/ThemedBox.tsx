





import React from "react";
import { Box, type BoxProps } from "ink";
import type { DOMElement } from "ink";
import { getTheme, resolveColor, type Theme } from "../../utils/theme.js";
import { useTheme } from "./ThemeProvider.js";


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




export type Props = Omit<BoxProps, BoxColorPropNames> &
  ThemedColorProps & {
    children?: React.ReactNode;
    ref?: React.Ref<DOMElement>;
  };

const RAW_COLOR_PREFIXES = ["rgb(", "#", "ansi256(", "ansi:"];


function isRawColor(value: string): boolean {
  return RAW_COLOR_PREFIXES.some((prefix) => value.startsWith(prefix));
}


function resolveColorValue(color: keyof Theme | string | undefined, theme: Theme): string | undefined {
  if (!color) return undefined;
  
  if (isRawColor(color)) {
    return resolveColor(color);
  }
  
  const resolved = theme[color as keyof Theme];
  return resolved === undefined ? undefined : resolveColor(resolved);
}


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
