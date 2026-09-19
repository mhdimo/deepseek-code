const DEFAULT_TERMINAL_ROWS = 40;

export const INK_RENDER_OPTIONS = {
  incrementalRendering: false,
  // Ctrl+C belongs to the app, not to Ink. Ink's built-in handler exits the
  // moment it sees the keypress — no chance to stop a running turn, no chance
  // to clean up — and while it is on, `useInput` handlers never receive the
  // key at all, so App's double-press protocol ("press again to exit", first
  // press only interrupts a running turn) was unreachable. Turning it off
  // hands every Ctrl+C to the input handler that already implements it.
  exitOnCtrlC: false,
} as const;

// DEC private mode 2004: the terminal wraps pasted text in ESC[200~ … ESC[201~
// markers instead of delivering it as a burst of keystrokes. Without it a paste
// is indistinguishable from very fast typing — there is no way to tell a line
// break inside a paste from the user pressing Enter, which is how half a pasted
// paragraph could be submitted on its own. Nothing turned it on (ink does not),
// so we do, and we turn it back off on the way out: it is the terminal's state,
// not ours, and leaving it on would hand the shell's readline markers it did
// not ask for.
export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";

export function safeTerminalRows(rows: number | undefined, fallback = DEFAULT_TERMINAL_ROWS): number {
  if (!rows || rows < 1) return Math.max(1, fallback);
  return Math.max(1, Math.floor(rows));
}

export function separatorWidth(columns: number | undefined): number {
  return Math.max(1, Math.floor(columns || 1));
}

export function transcriptContainerHeight(rows: number, promptRows: number): number {
  return Math.max(0, rows - promptRows);
}
