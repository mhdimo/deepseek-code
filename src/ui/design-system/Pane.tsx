// Pane — a region of the terminal that appears below the REPL prompt, bounded
// by a colored top line with a one-row gap above and horizontal padding.
// Used by slash-command screens: /config, /help, /plugins, /stats.
//
// Ported from claude-code-main/src/components/design-system/Pane.tsx onto
// stock Ink: the reference branches on useIsInsideModal() (FullscreenLayout's
// modal slot already owns the frame) — this app has no modal slot, so the
// divider + paddingX=2 branch is the only one that applies.

import React from "react";
import { Box } from "ink";
import type { Theme } from "../../utils/theme.js";
import { Divider } from "./Divider.js";

export type PaneProps = {
  children: React.ReactNode;
  /**
   * Theme color for the top border line.
   */
  color?: keyof Theme;
};

/**
 * A pane — a region of the terminal that appears below the REPL prompt,
 * bounded by a colored top line with a one-row gap above and horizontal
 * padding. Used by slash-command screens: /config, /help, /stats.
 *
 * For confirm/cancel dialogs (Esc to dismiss, Enter to confirm), use a
 * Dialog-style component instead — it registers its own keybindings.
 *
 * @example
 * <Pane color="permission">
 *   <Tabs title="Sandbox:">...</Tabs>
 * </Pane>
 */
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
