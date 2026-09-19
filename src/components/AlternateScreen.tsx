import React, { useInsertionEffect } from "react";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
/** Clear the screen and home the cursor. */
const CLEAR_AND_HOME = "\x1b[2J\x1b[H";

/**
 * Run children in the terminal's alternate screen buffer.
 *
 * `useInsertionEffect`, not `useEffect` or `useLayoutEffect`. The reference
 * uses one deliberately, and explains why: the reconciler calls
 * resetAfterCommit between the mutation and layout phases, and an ink render
 * pass hangs off that. A layout effect therefore runs *after* the first frame
 * has already been written to the main screen, and that frame is preserved
 * underneath the alt screen and revealed as a broken view on exit. Insertion
 * effects fire during the mutation phase, before any of that, so the terminal
 * has entered the alt screen by the time the first frame is drawn.
 *
 * Two things the reference does here are deliberately not ported, both
 * because they need its vendored ink rather than stock ink 6.8.0:
 *
 * - SGR mouse tracking (wheel and click/drag). Its ink parses those events
 *   into keys and selection state; ours does not, so enabling the mode would
 *   leave the terminal emitting escape sequences nothing consumes.
 * - `setAltScreenActive()` on the ink instance, which keeps the renderer's
 *   cursor inside the viewport. Stock ink exposes no such hook.
 */
export default function AlternateScreen({ children }: { children: React.ReactNode }): React.ReactElement {
  useInsertionEffect(() => {
    process.stdout.write(ENTER_ALT_SCREEN + CLEAR_AND_HOME);
    const leave = () => {
      process.stdout.write(LEAVE_ALT_SCREEN);
    };
    process.on("exit", leave);
    return () => {
      process.off("exit", leave);
      leave();
    };
  }, []);
  return <>{children}</>;
}
