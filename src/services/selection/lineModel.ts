/**
 * Text line model for mouse selection (port of Claude Code's selection
 * architecture: selection.ts + screen-buffer row model).
 *
 * The transcript's text rows are wrapped with the EXACT same algorithm ink
 * uses to render them (`wrap-ansi` with {trim:false, hard:true} — see
 * ink/build/wrap-text.js), so the model's rows are byte-identical to what
 * the renderer draws. Selection highlighting can therefore invert the right
 * cells, and copy extracts the exact visible text (soft-wrapped rows join
 * back into logical lines, matching terminal-native copy semantics).
 *
 * Styled runs (bold/italic/color from the markdown tokens) survive the wrap:
 * with trim:false wrap-ansi emits every source character exactly once, so
 * each output row is a contiguous substring of the source and the rows tile
 * it left-to-right. Style re-attachment is therefore a cursor walk over the
 * original runs — no need to replicate the wrap algorithm's internals.
 */

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  color?: string;
  /** Background color (used by diff rows and selection highlight). */
  backgroundColor?: string;
  /** Exclude this run from copy/word-extraction (diff padding fill —
   *  renders as a full-width background bar but pastes clean code). */
  copySkip?: boolean;
}

export interface StyledRun {
  text: string;
  style?: TextStyle;
}

export interface TextRow {
  runs: StyledRun[];
  /** True when this row ends at a word-wrap break (not a source newline). */
  softWrapped: boolean;
  /** Column offset of this row within its block (blockquote prefix, list
   *  indent). Selection columns are block-content-relative; subtract origin
   *  to get the row's local columns. */
  origin?: number;
}

const wrapConfig = { trim: false, hard: true } as const;

/** Slice runs by character offsets into their concatenation. */
function sliceRuns(runs: StyledRun[], start: number, end: number): StyledRun[] {
  const out: StyledRun[] = [];
  let off = 0;
  for (const r of runs) {
    const next = off + r.text.length;
    if (next > start && off < end) {
      const s = Math.max(0, start - off);
      const e = Math.min(r.text.length, end - off);
      if (e > s) out.push({ text: r.text.slice(s, e), style: r.style });
    }
    if (next >= end) break;
    off = next;
  }
  return out;
}

/**
 * Wrap a single source line (no \n) of styled runs to `width`. Rows are
 * byte-identical to ink's rendered output for the same text and width.
 */
export function wrapLineRuns(runs: StyledRun[], width: number): TextRow[] {
  if (runs.length === 0) return [{ runs: [], softWrapped: false }];
  const concat = runs.map((r) => r.text).join("");
  if (concat === "") return [{ runs: [], softWrapped: false }];

  const rows = wrapAnsi(concat, width, wrapConfig).split("\n");
  const out: TextRow[] = [];
  let cursor = 0;
  for (let ri = 0; ri < rows.length; ri++) {
    const text = rows[ri] ?? "";
    let span: StyledRun[];
    if (concat.slice(cursor, cursor + text.length) === text) {
      // Normal case: row is the source substring at the cursor.
      span = sliceRuns(runs, cursor, cursor + text.length);
      cursor += text.length;
    } else {
      // Fallback (should never happen with trim:false): locate by search.
      const start = concat.indexOf(text, cursor);
      const s = start === -1 ? concat.indexOf(text) : start;
      span = s === -1 ? [] : sliceRuns(runs, s, s + text.length);
      cursor = start === -1 ? cursor + text.length : start + text.length;
    }
    out.push({ runs: span, softWrapped: ri < rows.length - 1 });
  }
  return out;
}

/**
 * Wrap multi-line styled text at `width`. Source newlines produce hard
 * breaks (softWrapped=false on the row that ends them); wrap breaks are
 * soft. The final row is softWrapped=false (no break follows it).
 */
export function wrapTextRuns(runs: StyledRun[], width: number): TextRow[] {
  const out: TextRow[] = [];
  const lines: StyledRun[][] = [];
  let cur: StyledRun[] = [];
  for (const r of runs) {
    const parts = r.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push(cur);
        cur = [];
      }
      const part = parts[i]!;
      if (part !== "") cur.push({ text: part, style: r.style });
    }
  }
  lines.push(cur);
  for (let li = 0; li < lines.length; li++) {
    const rows = wrapLineRuns(lines[li] ?? [], width);
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri]!;
      const isLineEnd = ri === rows.length - 1;
      out.push({
        runs: row.runs,
        // wrap-ansi marked the row soft; it's only actually followed by a
        // wrap break when a next row of the SAME source line exists
        softWrapped: row.softWrapped && !isLineEnd,
      });
    }
  }
  return out;
}

/** Plain text of a row (for copy). Runs marked copySkip are excluded so
 *  diff padding fill doesn't paste as trailing whitespace. */
export function rowText(row: TextRow): string {
  return row.runs
    .filter((r) => !r.style?.copySkip)
    .map((r) => r.text)
    .join("");
}

/** Split a row's runs at a [startCol, endCol) visual-column selection. A
 *  char is selected iff its cell range [col, col+width) intersects the
 *  selection. Wide chars straddling a boundary are taken whole. */
export interface SplitRow {
  before: StyledRun[];
  selected: StyledRun[];
  after: StyledRun[];
}

/** Substring of `text` covering visual columns [fromCol, toCol). Wide
 *  chars straddling a boundary are taken whole (intersection rule). */
export function sliceTextByCols(text: string, fromCol: number, toCol: number): string {
  if (toCol <= fromCol) return "";
  let out = "";
  let col = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (col + w > fromCol && col < toCol) out += ch;
    col += w;
  }
  return out;
}

/** Single-line styled runs from plain text (user/system rows). */
export function textRuns(text: string): StyledRun[] {
  return [{ text, style: undefined }];
}

export function splitRowAt(row: TextRow, startCol: number, endCol: number): SplitRow {
  if (endCol <= startCol) return { before: row.runs, selected: [], after: [] };
  const before: StyledRun[] = [];
  const selected: StyledRun[] = [];
  const after: StyledRun[] = [];
  let col = 0;
  for (const run of row.runs) {
    for (const ch of run.text) {
      const w = stringWidth(ch);
      if (col + w <= startCol) {
        before.push({ text: ch, style: run.style });
      } else if (col < endCol) {
        selected.push({ text: ch, style: run.style });
      } else {
        after.push({ text: ch, style: run.style });
      }
      col += w;
    }
  }
  return { before, selected, after };
}
