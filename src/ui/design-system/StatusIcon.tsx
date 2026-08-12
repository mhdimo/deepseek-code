// StatusIcon — a status indicator icon with appropriate color. Ported from
// claude-code-main/src/components/design-system/StatusIcon.tsx. The reference
// uses the 'figures' package for glyphs; stock Ink 6 does not depend on it,
// so the glyphs are hardcoded (same set figures returns on non-Windows).

import React from "react";
import { Text } from "ink";
import { getTheme, resolveColor } from "../../utils/theme.js";
import { useTheme } from "./ThemeProvider.js";

type Status = "success" | "error" | "warning" | "info" | "pending" | "loading";

export type StatusIconProps = {
  /**
   * The status to display. Determines both the icon and color.
   *
   * - `success`: Green checkmark (✔)
   * - `error`: Red cross (✖)
   * - `warning`: Yellow warning symbol (⚠)
   * - `info`: Blue info symbol (ℹ)
   * - `pending`: Dimmed circle (○)
   * - `loading`: Dimmed ellipsis (…)
   */
  status: Status;
  /**
   * Include a trailing space after the icon. Useful when followed by text.
   * @default false
   */
  withSpace?: boolean;
};

const STATUS_CONFIG: Record<
  Status,
  { icon: string; color: "success" | "error" | "warning" | "suggestion" | undefined }
> = {
  success: { icon: "✔", color: "success" },
  error: { icon: "✖", color: "error" },
  warning: { icon: "⚠", color: "warning" },
  info: { icon: "ℹ", color: "suggestion" },
  pending: { icon: "○", color: undefined },
  loading: { icon: "…", color: undefined },
};

/**
 * Renders a status indicator icon with appropriate color.
 *
 * @example
 * // Success indicator
 * <StatusIcon status="success" />
 *
 * @example
 * // Error with trailing space for text
 * <Text><StatusIcon status="error" withSpace />Failed to connect</Text>
 *
 * @example
 * // Status line pattern
 * <Text>
 *   <StatusIcon status="pending" withSpace />
 *   Waiting for response
 * </Text>
 */
export function StatusIcon({ status, withSpace = false }: StatusIconProps): React.ReactNode {
  const config = STATUS_CONFIG[status];
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  // config.color is a theme key ('success' | 'error' | ...) — resolve it to a
  // raw ink color (stock Ink does not resolve theme keys itself).
  const resolvedColor = config.color ? resolveColor(theme[config.color]) : undefined;

  return (
    <Text color={resolvedColor} dimColor={!config.color}>
      {config.icon}
      {withSpace && " "}
    </Text>
  );
}
