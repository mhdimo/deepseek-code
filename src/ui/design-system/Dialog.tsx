
import React from "react";
import { Box, Text, useInput } from "ink";
import { theme, resolveColor, type Theme } from "../../utils/theme.js";
import { Divider } from "./Divider.js";

export interface DialogProps {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  /** Called on Escape (unless `cancelActive` is false, e.g. when an embedded input owns Esc). */
  onCancel: () => void;
  /** Dim input-guide footer line; omit for the default Enter/Esc hint. */
  footer?: React.ReactNode;
  /** Whether Escape triggers onCancel here. Set false when a child handles Esc. */
  cancelActive?: boolean;
  /** Title/rule color token (Claude Code `color` prop; defaults to permission). */
  color?: keyof Theme;
  /** Hide the footer input-guide line entirely. */
  hideInputGuide?: boolean;
  /** Hide the top rule + padding (embed inside another pane). */
  hideBorder?: boolean;
}

/**
 * Dialog shell for interactive slash commands — the Claude Code Pane layout:
 * a colored full-width top rule, title, dim subtitle, content, and a dim
 * input-guide footer. Frameless by design (no box border).
 */
export function Dialog({
  title,
  subtitle,
  children,
  onCancel,
  footer,
  cancelActive = true,
  color = "permission",
  hideInputGuide = false,
  hideBorder = false,
}: DialogProps): React.ReactElement {
  useInput((_input, key) => {
    if (cancelActive && key.escape) onCancel();
  });

  const colorToken =
    typeof (theme as Record<string, unknown>)[color] === "string"
      ? ((theme as Record<string, unknown>)[color] as string)
      : theme.permission;

  return (
    <Box flexDirection="column">
      {!hideBorder && <Divider color={color} />}
      <Box flexDirection="column" paddingX={hideBorder ? 0 : 2} marginTop={hideBorder ? 0 : 1}>
        <Text bold color={resolveColor(colorToken)}>{title}</Text>
        {subtitle && <Text dimColor>{subtitle}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {children}
        </Box>
        {!hideInputGuide && (
          <Box marginTop={1}>
            <Text dimColor italic>
              {footer ?? (
                <>
                  <Text bold>enter</Text> to confirm · <Text bold>esc</Text> to cancel
                </>
              )}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export default Dialog;
