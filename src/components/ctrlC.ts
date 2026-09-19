/**
 * What Ctrl+C means, as a decision rather than a pile of ifs.
 *
 * Ctrl+C is the key people press by reflex to make a thing stop, so if it is
 * bound wrong the session ends. It has been bound wrong twice: Ink's default
 * `exitOnCtrlC` ate the keypress before any handler saw it (so the app quit on
 * the first press and the double-press protocol below was unreachable), and
 * once that was off, the overlays that own the keyboard drifted out of the
 * handler one by one — Ctrl+C from inside the ctrl+r picker fell through to
 * "exit" because `showHistorySearch` was never added to the list.
 *
 * So precedence lives here, as data: an overlay that is open answers first, a
 * running turn is interrupted next, a draft in the box is cleared next, and
 * only an empty, idle prompt can arm the exit. The caller builds the overlay
 * list from its own state; `overlaysOf` exists so that list is written once
 * and read by both the decision and the drift guard in the tests.
 */

/** UI that owns the keyboard, most modal first. */
export type CtrlCOverlay =
  | "transcript"
  | "session-picker"
  | "settings"
  | "help"
  | "history-search"
  | "plugins"
  | "export"
  | "search-results"
  | "effort-callout"
  | "theme-picker"
  | "commands";

export type CtrlCAction =
  | { kind: "cancel-questions" }
  | { kind: "close-overlay"; overlay: CtrlCOverlay }
  | { kind: "abort" }
  | { kind: "clear-input" }
  | { kind: "exit" }
  | { kind: "arm-exit" };

export interface CtrlCState {
  /** A question card is waiting for an answer. */
  hasPendingQuestions: boolean;
  /** Open overlays, most modal first. Closed ones are omitted. */
  overlays: CtrlCOverlay[];
  /** A turn is streaming. */
  isLoading: boolean;
  /** The prompt has a non-empty draft. */
  hasDraft: boolean;
  /** When the previous Ctrl+C armed the exit (0 = it never did). */
  lastCtrlCAt: number;
  now: number;
}

/** How long a single Ctrl+C stays armed as "the first of two". */
export const EXIT_ARM_WINDOW_MS = 1500;

/**
 * Collect the open overlays, in precedence order, dropping the closed ones.
 *
 * `[[name, open], …]` rather than an object so the order is the code's order —
 * the list is a precedence list, and an object's key order is a weaker promise
 * than an array's.
 */
export function overlaysOf(pairs: Array<[CtrlCOverlay, boolean]>): CtrlCOverlay[] {
  return pairs.filter(([, open]) => open).map(([name]) => name);
}

export function ctrlCAction(state: CtrlCState): CtrlCAction {
  // A question card is a promise to the model that a human is answering it.
  // Closing it must reject, not abandon.
  if (state.hasPendingQuestions) return { kind: "cancel-questions" };

  // Whatever owns the screen answers first: an overlay that is open is what
  // the user is looking at, and Ctrl+C there means "close this".
  const overlay = state.overlays[0];
  if (overlay !== undefined) return { kind: "close-overlay", overlay };

  // A running turn is next — stop spending tokens before anything else.
  if (state.isLoading) return { kind: "abort" };

  // Then the draft: the reference's rule, and the difference between cancel
  // and exit for the keypress people reach for by reflex.
  if (state.hasDraft) return { kind: "clear-input" };

  // Only an idle, empty prompt arms the exit, and only briefly.
  return state.now - state.lastCtrlCAt < EXIT_ARM_WINDOW_MS
    ? { kind: "exit" }
    : { kind: "arm-exit" };
}
