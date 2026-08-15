





import React, { useContext } from "react";
import { Text } from "ink";
import { getTheme, resolveColor, type Theme } from "../../utils/theme.js";
import { useTheme } from "./ThemeProvider.js";


export const TextHoverColorContext = React.createContext<keyof Theme | undefined>(undefined);

export type Props = {
  
  readonly color?: keyof Theme | string;

  
  readonly backgroundColor?: keyof Theme;

  
  readonly dimColor?: boolean;

  
  readonly bold?: boolean;

  
  readonly italic?: boolean;

  
  readonly underline?: boolean;

  
  readonly strikethrough?: boolean;

  
  readonly inverse?: boolean;

  
  readonly wrap?: "wrap" | "end" | "middle" | "truncate" | "truncate-end" | "truncate-middle" | "truncate-start";

  readonly children?: React.ReactNode;
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


export default function ThemedText({
  color,
  backgroundColor,
  dimColor = false,
  bold = false,
  italic = false,
  underline = false,
  strikethrough = false,
  inverse = false,
  wrap = "wrap",
  children,
}: Props): React.ReactNode {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const hoverColor = useContext(TextHoverColorContext);

  
  const resolvedColor =
    !color && hoverColor
      ? resolveColorValue(hoverColor, theme)
      : dimColor
        ? resolveColor(theme.inactive)
        : resolveColorValue(color, theme);
  const resolvedBackgroundColor = backgroundColor ? resolveColor(theme[backgroundColor]!) : undefined;

  return (
    <Text
      color={resolvedColor}
      backgroundColor={resolvedBackgroundColor}
      bold={bold}
      italic={italic}
      underline={underline}
      strikethrough={strikethrough}
      inverse={inverse}
      wrap={wrap}
    >
      {children}
    </Text>
  );
}
