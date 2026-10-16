/**
 * The scroll window a pointer-driven selection shows.
 *
 * The pickers derive their window from the selection — centred on it, for
 * parity with the keyboard — which is right for a keystroke and wrong for a
 * hover. A pointer move that recentres slides the list out from under the
 * cursor and lights up a row the pointer is not on: the highlight must land
 * on the row being pointed at, and the list must not move to show it.
 *
 * So a hover pins the window at whatever start was in effect when it moved
 * the selection. The pin lapses by itself the moment anything else moves the
 * selection — the keyboard, a click, a filter that resets the index — because
 * it only applies while the selection is still the row the pointer picked.
 */
import { useCallback, useState } from "react";

/** The window start to render. */
export interface PinnedWindowArgs {
  /** The row a hover selected, and the window that was on screen then. */
  pinned: { index: number; start: number } | null;
  selectedIndex: number;
  /** Rows in the list, and rows the window shows. */
  count: number;
  size: number;
  /** The window the selection would get on its own (the centred one). */
  auto: number;
}

export function pinnedWindowStart({
  pinned,
  selectedIndex,
  count,
  size,
  auto,
}: PinnedWindowArgs): number {
  const maxStart = Math.max(0, count - size);
  let start = pinned && pinned.index === selectedIndex ? pinned.start : auto;
  // A pinned window still has to show the selection — if the list changed
  // under it, the window slides just far enough to bring it back.
  start = Math.min(start, selectedIndex);
  start = Math.max(start, selectedIndex - size + 1);
  return Math.max(0, Math.min(start, maxStart));
}

export interface HoverPin {
  /** The start row to render, given the automatic (centred) one. */
  start: (auto: number) => number;
  /** Called by a hover handler with the row it selected and the window that
   *  was on screen at that moment. */
  pin: (index: number, start: number) => void;
}

/** A window that the pointer cannot scroll. See the module comment. */
export function useHoverPin(selectedIndex: number, count: number, size: number): HoverPin {
  const [pinned, setPinned] = useState<{ index: number; start: number } | null>(null);
  const start = useCallback(
    (auto: number) => pinnedWindowStart({ pinned, selectedIndex, count, size, auto }),
    [pinned, selectedIndex, count, size],
  );
  const pin = useCallback((index: number, startRow: number) => {
    setPinned({ index, start: startRow });
  }, []);
  return { start, pin };
}
