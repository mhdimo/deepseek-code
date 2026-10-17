/**
 * Renderer for Deepy, and the two sizes of the mascot itself: the animated
 * whale sprite (see deepyWhale.ts for the pixel data), and the three-glyph
 * version below for the screens that give the mascot only a few rows.
 *
 * Two vertically adjacent sprite pixels pack into one half-block cell: the
 * top pixel is the cell's foreground and the bottom its background, drawn as
 * `▀`. Where half the cell is transparent only `▀`/`▄` is painted and the
 * rest keeps the terminal background.
 *
 * Two renderings, picked by terminal capability:
 *   - deepyWhaleFrame() — the sprite's own 24-bit palette, embedded as raw
 *     SGR so a whole row is one Text child instead of one per cell.
 *   - deepyWhaleSolid() — a monochrome silhouette (`█`/`▀`/`▄`) for terminals
 *     without truecolor; the caller colors it (one Text per row).
 */
import { useEffect, useState } from "react";
import { DEEPY_IDLE, DEEPY_PALETTE, type DeepyFrame } from "./deepyWhale.js";

export interface DeepyCell {
  /** Sprite pixel in the top half: #rrggbb, or null when transparent. */
  top: string | null;
  /** Sprite pixel in the bottom half: #rrggbb, or null when transparent. */
  bottom: string | null;
}

/**
 * Deepy at header size: three glyph rows, small enough to sit beside a
 * screen's title line. Drawn with a single foreground color (`░` shades
 * itself), so unlike the sprite above it needs no palette.
 */
export interface DeepyMiniFrame {
  top: string;
  mid: string;
  bot: string;
}

/**
 * Only the eyes move — row 3's two `▄`/`▀`/`█` pairs.
 */
export const DEEPY_MINI_FRAMES: readonly DeepyMiniFrame[] = [
  { top: "    ▄▄▄▄▄▄▄    ", mid: "  ▄▀░░░░░░░▀▄  ", bot: " █░░▄░░░░▄░░░█  " },
  { top: "    ▄▄▄▄▄▄▄    ", mid: "  ▄▀░░░░░░░▀▄  ", bot: " █░░▀░░░░▀░░░█  " },
  { top: "    ▄▄▄▄▄▄▄    ", mid: "  ▄▀░░░░░░░▀▄  ", bot: " █░░░░██░░░░░█  " },
];

/** The whale's body blue — the solid rendering's one color. */
export const DEEPY_BLUE = "#4E6FFF";

/** Pack a pixel grid into half-block cells, bottom of an odd grid = empty. */
export function packDeepyFrame(rows: readonly string[]): DeepyCell[][] {
  const cells: DeepyCell[][] = [];
  for (let r = 0; r < rows.length; r += 2) {
    const top = rows[r] ?? "";
    const bottom = rows[r + 1] ?? "";
    const row: DeepyCell[] = [];
    for (let c = 0; c < top.length; c++) {
      const t = top[c] ?? ".";
      const b = bottom[c] ?? ".";
      row.push({
        top: t === "." ? null : (DEEPY_PALETTE[t] ?? null),
        bottom: b === "." ? null : (DEEPY_PALETTE[b] ?? null),
      });
    }
    // Trailing transparent cells are dropped: they cost width in the
    // layout for pixels no one can see.
    while (row.length > 0) {
      const last = row[row.length - 1]!;
      if (last.top !== null || last.bottom !== null) break;
      row.pop();
    }
    cells.push(row);
  }
  while (cells.length > 0 && cells[cells.length - 1]!.length === 0) {
    cells.pop();
  }
  return cells;
}

function sgr(hex: string, background: boolean): string {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[${background ? 48 : 38};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

const DEFAULT_FG = "\x1b[39m";
const DEFAULT_BG = "\x1b[49m";
const RESET = "\x1b[0m";

/** Truecolor rows with the sprite's own palette, one string per row. */
export function deepyWhaleFrame(frame: DeepyFrame): string[] {
  return packDeepyFrame(frame.rows).map((cells) => {
    const out = cells
      .map((cell) => {
        if (cell.top && cell.bottom) return `${sgr(cell.top, false)}${sgr(cell.bottom, true)}▀`;
        if (cell.top) return `${sgr(cell.top, false)}${DEFAULT_BG}▀`;
        if (cell.bottom) return `${sgr(cell.bottom, false)}${DEFAULT_BG}▄`;
        return `${DEFAULT_FG}${DEFAULT_BG} `;
      })
      .join("");
    return out + RESET;
  });
}

/** Monochrome silhouette — plain block characters, no escape codes. */
export function deepyWhaleSolid(frame: DeepyFrame): string[] {
  return packDeepyFrame(frame.rows).map((cells) =>
    cells
      .map((cell) => {
        if (cell.top && cell.bottom) return "█";
        if (cell.top) return "▀";
        if (cell.bottom) return "▄";
        return " ";
      })
      .join(""),
  );
}

let truecolor: boolean | null = null;

/** Whether the terminal can be expected to honor 24-bit SGR. */
export function deepyTruecolor(): boolean {
  if (truecolor === null) {
    // Respect the standard opt-outs first: `hasColors` reports what the
    // terminal is capable of, not what the user asked for.
    if (process.env.NO_COLOR || process.env.FORCE_COLOR === "0") {
      truecolor = false;
    } else {
      const out = process.stdout as unknown as { hasColors?: (depth?: number) => boolean };
      truecolor = typeof out.hasColors === "function" ? out.hasColors(16_777_216) : false;
    }
  }
  return truecolor;
}

/** Cycle an animation on its own per-frame durations. */
export function useDeepyFrame(
  enabled: boolean,
  frames: readonly DeepyFrame[] = DEEPY_IDLE,
): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!enabled || frames.length < 2) return;
    const timer = setTimeout(
      () => setIndex((prev) => (prev + 1) % frames.length),
      frames[index % frames.length]!.dur,
    );
    return () => clearTimeout(timer);
  }, [enabled, index, frames]);
  return enabled ? index % frames.length : 0;
}
