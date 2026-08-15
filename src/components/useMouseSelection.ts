/**
 * Mouse selection + copy-on-select (port of Claude Code's selection stack:
 * selection.ts + use-selection.ts + useCopyOnSelect.ts).
 *
 * Wheel scrolling requires terminal mouse tracking, which kills the
 * terminal's native copy-on-select — so this hook replaces it with an
 * in-app selection state machine driven by the SAME internal_eventEmitter
 * stream the wheel hook uses:
 *
 *   press (btn 0)          → anchor selection at the cell (or word/line on
 *                            double/triple click, 500ms window)
 *   drag (btn 32, ?1002h)  → extend focus
 *   release (btn 3)        → copy the selected text to the clipboard
 *   wheel (btn 64/65)      → clear the selection (wheel hook scrolls)
 *   Esc                    → clear (handled by App's useInput)
 *
 * Coordinates: SGR reports 1-based screen cells; content coordinates are
 * screen minus (topOffset + scrollTop) for rows and minus 1 for columns,
 * clamped into the transcript's row grid.
 */

import { useEffect, useRef } from "react";
import { useStdin } from "ink";
import stringWidth from "string-width";
import type { ChatPanelHandle } from "./ChatPanel.js";

/** Normalized selection in content coordinates: rows inclusive,
 *  [startCol, endCol) per boundary row. */
export interface ContentSelection {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const MULTI_CLICK_MS = 500;
const MAX_MULTI = 3;

interface DragState {
  anchorRow: number;
  anchorCol: number;
  focusRow: number;
  focusCol: number;
  dragging: boolean;
  multi: 1 | 2 | 3;
  lastPress: { row: number; col: number; time: number };
  active: boolean;
}

/** Copy text to the clipboard: pbcopy (macOS) with OSC 52 fallback. */
export function copyToClipboard(text: string): boolean {
  try {
    const { execSync } = require("node:child_process");
    execSync("pbcopy", { input: text });
    return true;
  } catch {
    try {
      process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
      return true;
    } catch {
      return false;
    }
  }
}

/** Visual-column bounds of the word (or space run) containing `col` in
 *  `text`. Mirrors Claude Code's WORD_CHAR classification. */
export function wordBoundsAt(text: string, col: number): [number, number] | null {
  const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u;
  if (col < 0) return null;
  // Find the char whose cell range contains col (wide chars taken whole).
  let i = 0;
  let c = 0;
  let at: { i: number; c: number } | null = null;
  for (; i < text.length; i++) {
    const w = stringWidth(text[i]!);
    if (col < c + w) {
      at = { i, c };
      break;
    }
    c += w;
  }
  if (!at) return null;
  const isWord = WORD_CHAR.test(text[at.i]!);
  if (!isWord) return null; // space/other — no word selection
  // walk left/right within the same class
  let start = at.i;
  let end = at.i;
  while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--;
  while (end < text.length - 1 && WORD_CHAR.test(text[end + 1]!)) end++;
  // convert char range to col range
  let startCol = 0;
  let endCol = 0;
  for (let k = 0; k <= end; k++) {
    const w = stringWidth(text[k]!);
    if (k < start) startCol += w;
    endCol += w;
  }
  return [startCol, endCol];
}

export function useMouseSelection(
  chatRef: React.RefObject<ChatPanelHandle | null>,
  onChange: (sel: ContentSelection | null) => void,
): void {
  const { stdin, setRawMode, internal_eventEmitter } = useStdin();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const stateRef = useRef<DragState>({
    anchorRow: 0,
    anchorCol: 0,
    focusRow: 0,
    focusCol: 0,
    dragging: false,
    multi: 1,
    lastPress: { row: -1, col: -1, time: 0 },
    active: false,
  });

  useEffect(() => {
    if (!stdin?.isTTY) return;
    setRawMode(true);
    // Button-event tracking (?1002h) is required for drag sequences.
    process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");

    const onInput = (data: string) => {
      const s = stateRef.current;
      SGR_MOUSE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SGR_MOUSE_RE.exec(data))) {
        const btn = Number(m[1]);
        const col = Number(m[2]);
        const row = Number(m[3]);
        const vp = chatRef.current?.getViewport();
        if (!vp) continue;
        const contentRow = row - 1 - vp.topOffset + vp.scrollTop;
        const contentCol = col - 1;
        if (contentRow < 0 || contentRow >= vp.totalRows) {
          // press outside the transcript (banner, below content, overlays)
          if (btn === 3 && s.dragging) {
            s.dragging = false;
          }
          continue;
        }
        const c = Math.max(0, Math.min(contentCol, vp.width));

        // Wheel (with or without modifiers) — clear the selection; the
        // wheel hook handles the actual scrolling.
        if ((btn & 0x40) !== 0) {
          if (s.active) {
            s.active = false;
            s.dragging = false;
            onChangeRef.current(null);
          }
          continue;
        }

        const base = btn & ~28; // strip shift/meta/ctrl modifiers
        if (base === 0) {
          // press
          const now = Date.now();
          const sameCell =
            s.lastPress.row === contentRow &&
            s.lastPress.col === c &&
            now - s.lastPress.time < MULTI_CLICK_MS;
          s.multi = sameCell ? (Math.min(MAX_MULTI, s.multi + 1) as 1 | 2 | 3) : 1;
          s.lastPress = { row: contentRow, col: c, time: now };
          s.anchorRow = contentRow;
          s.anchorCol = c;
          s.focusRow = contentRow;
          s.focusCol = c;
          s.dragging = true;
          s.active = true;

          if (s.multi === 2) {
            const rowAt = chatRef.current?.getRowAt(contentRow);
            const bounds = rowAt ? wordBoundsAt(rowAt.text, c - rowAt.origin) : null;
            if (rowAt && bounds) {
              const [startCol, endCol] = bounds;
              // Store the word bounds so the release (which copies
              // normalize(anchor, focus)) copies the whole word.
              s.anchorCol = rowAt.origin + startCol;
              s.focusCol = rowAt.origin + endCol;
              onChangeRef.current({
                startRow: contentRow,
                endRow: contentRow,
                startCol: s.anchorCol,
                endCol: s.focusCol,
              });
              continue;
            }
            // fall through: no word here — plain cell selection
          } else if (s.multi === 3) {
            s.anchorCol = 0;
            s.focusCol = vp.width;
            onChangeRef.current({
              startRow: contentRow,
              endRow: contentRow,
              startCol: 0,
              endCol: vp.width,
            });
            continue;
          }
          onChangeRef.current({
            startRow: contentRow,
            endRow: contentRow,
            startCol: c,
            endCol: c,
          });
        } else if (base === 0x20) {
          // drag
          if (!s.dragging || !s.active) continue;
          s.focusRow = contentRow;
          s.focusCol = c;
          if (s.multi === 2) {
            // Word-extend: snap the anchor edge to the start of its word and
            // the focus edge to the end of its word, direction-aware. Stored
            // into anchor/focus so release copies the extended word range.
            const anchorIsFirst =
              s.anchorRow < contentRow || (s.anchorRow === contentRow && s.anchorCol <= c);
            const anchorRowAt = chatRef.current?.getRowAt(s.anchorRow);
            const boundsA = anchorRowAt
              ? wordBoundsAt(anchorRowAt.text, s.anchorCol - anchorRowAt.origin)
              : null;
            if (anchorRowAt && boundsA) {
              s.anchorCol = anchorRowAt.origin + (anchorIsFirst ? boundsA[0] : boundsA[1]);
            }
            const focusRowAt = chatRef.current?.getRowAt(contentRow);
            const boundsF = focusRowAt ? wordBoundsAt(focusRowAt.text, c - focusRowAt.origin) : null;
            if (focusRowAt && boundsF) {
              s.focusCol = focusRowAt.origin + (anchorIsFirst ? boundsF[1] : boundsF[0]);
            }
            onChangeRef.current({
              startRow: Math.min(s.anchorRow, contentRow),
              endRow: Math.max(s.anchorRow, contentRow),
              startCol: Math.min(s.anchorCol, s.focusCol),
              endCol: Math.max(s.anchorCol, s.focusCol),
            });
          } else if (s.multi === 3) {
            const n = normalize(s);
            onChangeRef.current({
              startRow: n.startRow,
              endRow: n.endRow,
              startCol: 0,
              endCol: vp.width,
            });
          } else {
            onChangeRef.current(normalize(s));
          }
        } else if (base === 3) {
          // release
          if (s.dragging) {
            s.dragging = false;
            const sel = normalize(s);
            const text = chatRef.current?.copySelection(sel) ?? "";
            if (text.trim().length > 0) copyToClipboard(text);
          }
        }
        // buttons 1/2 (middle/right) and their drags: ignored
      }
    };

    const disable = () => {
      try {
        process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
      } catch {}
    };
    internal_eventEmitter?.on("input", onInput);
    process.on("exit", disable);
    return () => {
      internal_eventEmitter?.off("input", onInput);
      disable();
      setRawMode(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdin, internal_eventEmitter]);

  void chatRef;
}

function normalize(s: DragState): ContentSelection {
  const startRow = Math.min(s.anchorRow, s.focusRow);
  const endRow = Math.max(s.anchorRow, s.focusRow);
  const startCol = startRow === s.anchorRow ? s.anchorCol : s.focusCol;
  const endCol = endRow === s.focusRow ? s.focusCol : s.anchorCol;
  return { startRow, endRow, startCol, endCol };
}
