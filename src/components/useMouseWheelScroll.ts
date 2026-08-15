import React, { useEffect, useRef } from "react";
import { useStdin } from "ink";

/**
 * Mouse-wheel scrolling for the chat transcript (Claude Code parity).
 *
 * Stock ink has no mouse support, so this hook:
 *   1. enables terminal mouse reporting in SGR mode (`?1000h` = wheel + button
 *      press events, `?1006h` = SGR coordinates) on mount, disables on unmount
 *      AND on process exit (React cleanup never runs on process.exit());
 *   2. listens on ink's internal input emitter — the raw stdin chunks, ESC
 *      intact — NOT on `stdin.on("data")`, which would switch the stream to
 *      flowing mode and starve ink's 'readable'-based input loop (all
 *      keyboard input dies for the session);
 *   3. parses wheel events (SGR button 64 = up, 65 = down; modifier bits
 *      shift=4 / meta=8 / ctrl=16 are stripped with `& ~28`) and translates
 *      them into scrollBy calls on the target scroll handle.
 *
 * Like Claude Code's ScrollKeybindingHandler, wheel events scroll the
 * transcript regardless of mouse position (the input treats wheel as a
 * no-op). Step sizing mirrors their empirically-tuned acceleration: a slow
 * notch scrolls ~2 rows, fast consecutive notches ramp to a cap of 6, and an
 * idle pause or direction flip resets back to the baseline.
 */

export interface WheelScrollTarget {
  scrollBy: (dy: number) => void;
}

/** Baseline rows per wheel notch. */
const WHEEL_BASE = 2;
/** Rows added per fast consecutive notch. */
const WHEEL_ACCEL_STEP = 0.3;
/** Max rows per notch. */
const WHEEL_ACCEL_MAX = 6;
/** Events closer than this (ms) are "fast" and ramp acceleration. */
const WHEEL_FAST_GAP_MS = 80;
/** Pause longer than this (ms) resets acceleration to baseline. */
const WHEEL_IDLE_MS = 500;

const SGR_WHEEL_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * True when an input string (as delivered by ink's useInput, ESC already
 * stripped) is a terminal SGR mouse sequence like `[<64;10;15M`. Every
 * useInput handler must reject these up front — ink gives them an empty
 * key name, so without a guard the raw sequence gets typed into the prompt
 * buffer or misread as a keypress.
 */
export function isMouseSequence(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]$/.test(input);
}

export function useMouseWheelScroll(target: React.RefObject<WheelScrollTarget | null>) {
  const { stdin, setRawMode, internal_eventEmitter } = useStdin();
  const accelRef = useRef({ last: 0, mult: WHEEL_BASE, dir: 0 as 1 | -1 | 0 });

  useEffect(() => {
    // Non-TTY stdin (--print, CI pipes) has no terminal to report mouse
    // events; enabling reporting into a pipe would emit garbage.
    if (!stdin?.isTTY) return;

    // Raw mode makes stdin deliver key/mouse bytes immediately (no line
    // buffering, no echo). ink counts consumers, so this is safe alongside
    // useInput elsewhere in the tree.
    setRawMode(true);
    // Enable mouse reporting. Written directly to stdout (not through ink's
    // renderer) so it lands in the terminal's state machine as raw control.
    // ?1002h (button-event tracking) is required by useMouseSelection's
    // drag sequences; enabling it here too keeps the two hooks' modes
    // identical (writes are idempotent).
    process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");

    const onInput = (raw: string) => {
      SGR_WHEEL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SGR_WHEEL_RE.exec(raw)) !== null) {
        const button = Number(m[1]);
        // Strip modifier bits: shift=4, meta=8, ctrl=16 (28 = 4|8|16).
        const base = button & ~28;
        if (base !== 64 && base !== 65) continue;
        const dir = base === 64 ? -1 : 1;
        const now = performance.now();
        const a = accelRef.current;
        if (now - a.last > WHEEL_IDLE_MS || dir !== a.dir) {
          a.mult = WHEEL_BASE; // idle pause or direction flip resets
        } else if (now - a.last < WHEEL_FAST_GAP_MS) {
          a.mult = Math.min(WHEEL_ACCEL_MAX, a.mult + WHEEL_ACCEL_STEP);
        }
        a.last = now;
        a.dir = dir;
        target.current?.scrollBy(dir * Math.floor(a.mult));
      }
    };

    // Hook ink's internal emitter (raw chunk, ESC intact) rather than the
    // stream itself — see note 2 in the header comment.
    internal_eventEmitter?.on("input", onInput);

    // App.tsx calls process.exit() on several exit paths; React unmount
    // cleanup never runs there, so the terminal would be left with mouse
    // reporting enabled and the next shell would flood with raw SGR
    // sequences. Disable on process exit too (reverse order: 1006 first).
    const disable = () => process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
    process.on("exit", disable);

    return () => {
      internal_eventEmitter?.off("input", onInput);
      process.off("exit", disable);
      disable();
      setRawMode(false);
    };
  }, [target, stdin, setRawMode, internal_eventEmitter]);
}
