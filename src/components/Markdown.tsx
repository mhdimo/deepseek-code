















import React, { useMemo, useRef } from "react";
import { Text, Box } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import { highlightLine } from "./codeHighlight.js";
import type { StyledRun, TextStyle, TextRow } from "../services/selection/lineModel.js";
import { wrapTextRuns, splitRowAt, rowText } from "../services/selection/lineModel.js";
import type { ContentSelection } from "./useMouseSelection.js";






type TokenType = "text" | "bold" | "italic" | "code-inline" | "link";

interface Token {
  type: TokenType;
  content: string;
  href?: string;
}





type BlockType =
  | "paragraph"
  | "heading"
  | "code-block"
  | "list-item"
  | "blockquote"
  | "hr"
  | "table";

interface Block {
  type: BlockType;
  level?: number;
  language?: string;
  content?: string;
  tokens?: Token[];
  indent?: number;
  ordered?: boolean;
  index?: number;
  header?: string[];
  align?: ("left" | "center" | "right")[];
  rows?: string[][];
}






const INLINE_PATTERNS: readonly {
  regex: RegExp;
  type: TokenType;
  group: (m: RegExpMatchArray) => { content: string; href?: string };
}[] = [
  {
    
    regex: /^(`+)([\s\S]*?)\1/,
    type: "code-inline",
    group: (m) => ({ content: m[2] ?? "" }),
  },
  {
    
    regex: /^\[([^\]]*)\]\(([^)]*)\)/,
    type: "link",
    group: (m) => ({ content: m[1] ?? "", href: m[2] ?? "" }),
  },
  {
    
    regex: /^\*\*\*([\s\S]+?)\*\*\*/,
    type: "bold",
    group: (m) => ({ content: m[1] ?? "" }),
  },
  {
    
    regex: /^\*\*([\s\S]+?)\*\*/,
    type: "bold",
    group: (m) => ({ content: m[1] ?? "" }),
  },
  {
    
    regex: /^\*(?!\s)([\s\S]+?)(?<!\s)\*/,
    type: "italic",
    group: (m) => ({ content: m[1] ?? "" }),
  },
  {
    
    regex: /^_(?!\s)([\s\S]+?)(?<!\s)_/,
    type: "italic",
    group: (m) => ({ content: m[1] ?? "" }),
  },
];


const SPECIAL_CHARS = new Set(["`", "[", "*", "_"]);


function nextSpecialFrom(text: string, start: number): number {
  for (let j = start; j < text.length; j++) {
    if (SPECIAL_CHARS.has(text[j]!)) return j;
  }
  return text.length;
}

function tokenizeInline(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    let matched = false;

    
    if (SPECIAL_CHARS.has(text[i]!)) {
      const rest = text.slice(i);

      for (const pattern of INLINE_PATTERNS) {
        const m = rest.match(pattern.regex);
        if (m) {
          tokens.push({
            type: pattern.type,
            ...pattern.group(m),
          });
          i += m[0].length;
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      
      const start = i;
      i = nextSpecialFrom(text, start + 1);
      
      
      
      tokens.push({ type: "text", content: text.slice(start, i) });

      
      
      
      
      if (i < len && SPECIAL_CHARS.has(text[i]!)) {
        const rest = text.slice(i);
        let triggers = false;
        for (const p of INLINE_PATTERNS) {
          if (p.regex.test(rest)) {
            triggers = true;
            break;
          }
        }
        if (!triggers) {
          
          i++;
        }
      }
    }
  }

  return mergeTextTokens(tokens);
}


function mergeTextTokens(tokens: Token[]): Token[] {
  const merged: Token[] = [];
  for (const tok of tokens) {
    const last = merged[merged.length - 1];
    if (last && last.type === "text" && tok.type === "text") {
      last.content += tok.content;
    } else {
      merged.push({ ...tok });
    }
  }
  return merged;
}





/**
 * Nesting depth (0-based) of a list item whose marker starts at `rawIndent`
 * source columns, given the indents of the enclosing items still open.
 *
 * The reference indents by marked's nesting level, not by the source's leading
 * whitespace (``${'  '.repeat(listDepth)}`` per level — see the list-item case
 * in wrapBlockRows for the columns that adds up to), and marked treats a
 * four-space-indented nested item as one level in, so the raw space count is
 * not the depth. Indents are tracked as a stack of open levels instead: deeper
 * than the innermost opens a level, shallower closes levels.
 */
function listDepthFor(stack: number[], rawIndent: number): number {
  while (stack.length > 0 && rawIndent < stack[stack.length - 1]!) stack.pop();
  if (stack.length === 0 || rawIndent > stack[stack.length - 1]!) stack.push(rawIndent);
  return stack.length - 1;
}

/**
 * Parse a list of source lines into blocks, recording the source line index
 * of each block's first line (blockLineIdx). Line-accurate offsets make the
 * streaming incremental re-parse possible: appending text only ever changes
 * the LAST block, so the tail can be re-parsed from that block's first line.
 *
 * List nesting is the one piece of parser state that spans lines, so the
 * indent stack in effect at each block is recorded too (blockIndentStack):
 * `seedStack` lets a tail re-parse start with the stack the full parse
 * would have had there.
 */
interface ParsedLines {
  blocks: Block[];
  blockLineIdx: number[];
  blockIndentStack: number[][];
}

function parseLines(lines: string[], seedStack: number[] = []): ParsedLines {
  const blocks: Block[] = [];
  const blockLineIdx: number[] = [];
  const blockIndentStack: number[][] = [];
  const indentStack: number[] = [...seedStack];
  const pushBlock = (lineIdx: number, block: Block): void => {
    blockLineIdx.push(lineIdx);
    blockIndentStack.push([...indentStack]);
    blocks.push(block);
  };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;


    if (line.trim() === "") {
      i++;
      continue;
    }


    if (/^(?:[-*_]){3,}\s*$/.test(line) && !/[^-*_\s]/.test(line)) {
      pushBlock(i, { type: "hr" });
      i++;
      continue;
    }

    
    const fenceMatch = line.match(/^```(\S*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines: string[] = [];
      const fenceStart = i;
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      pushBlock(fenceStart, {
        type: "code-block",
        language: lang || undefined,
        content: codeLines.join("\n"),
      });
      continue;
    }

    
    // (.*) not (.+): a marker-only line like "## " arrives mid-stream while
    // the model is still typing the heading text — it must be CONSUMED,
    // not left for the paragraph branch to deadlock on (the paragraph
    // terminator matches the marker but the heading pattern didn't, so
    // neither branch advanced = infinite loop).
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch && /^#{1,6}\s+/.test(line)) {
      const level = headingMatch[1]!.length;
      const content = headingMatch[2]!.replace(/\s*#+\s*$/, "");
      pushBlock(i, {
        type: "heading",
        level,
        tokens: content ? tokenizeInline(content) : [],
      });
      i++;
      continue;
    }

    
    if (/^>\s?/.test(line)) {
      const quoteStart = i;
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      // ONE block for the whole run of `>` lines. The reference prefixes the
      // bar to every line of a blockquote token, so splitting a quote into a
      // block per source line would put the inter-block spacer (a blank row)
      // between the bar-prefixed lines.
      pushBlock(quoteStart, {
        type: "blockquote",
        tokens: tokenizeInline(quoteLines.join("\n")),
      });
      continue;
    }

    
    if (/^\s*([-*+])\s+/.test(line)) {
      const listStart = i;
      let itemIdx = 0;
      while (i < lines.length) {
        // (.*) not (.+): a marker-only line like "- " arrives mid-stream
        // while the model types the item text — consume it as an empty
        // item instead of deadlocking (see heading branch comment).
        const liMatch = lines[i]?.match(/^(\s*)([-*+])\s+(.*)$/);
        if (!liMatch) break;
        const indentLevel = listDepthFor(indentStack, liMatch[1]!.length);
        pushBlock(listStart + itemIdx, {
          type: "list-item",
          indent: indentLevel,
          ordered: false,
          tokens: liMatch[3] ? tokenizeInline(liMatch[3]!) : [],
        });
        itemIdx++;
        i++;
      }
      continue;
    }

    
    if (/^\s*\d+\.\s+/.test(line)) {
      const listStart = i;
      let itemIdx = 0;
      while (i < lines.length) {
        // Marker-only lines ("1. ") consumed as empty items (see heading).
        const liMatch = lines[i]?.match(/^(\s*)(\d+)\.\s+(.*)$/);
        if (!liMatch) break;
        const indentLevel = listDepthFor(indentStack, liMatch[1]!.length);
        pushBlock(listStart + itemIdx, {
          type: "list-item",
          indent: indentLevel,
          ordered: true,
          // The SOURCE number, not a group counter — a counter restarts at
          // 1 when the incremental re-parse starts mid-group, and standard
          // markdown renders the numbers as typed anyway.
          index: parseInt(liMatch[2]!, 10),
          tokens: liMatch[3] ? tokenizeInline(liMatch[3]!) : [],
        });
        itemIdx++;
        i++;
      }
      continue;
    }

    
    const tableSep = (l: string) =>
      /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l) && l.includes("-") && l.includes("|");
    if (line.includes("|") && i + 1 < lines.length && tableSep(lines[i + 1]!)) {
      const splitRow = (l: string) =>
        l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const parseAlign = (cells: string[]) =>
        cells.map((s) => {
          const t = s.trim();
          const left = t.startsWith(":");
          const right = t.endsWith(":");
          if (left && right) return "center" as const;
          if (right) return "right" as const;
          return "left" as const;
        });
      const header = splitRow(line);
      const align = parseAlign(splitRow(lines[i + 1]!));
      const tableStart = i;
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      pushBlock(tableStart, { type: "table", header, align, rows });
      continue;
    }

    
    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === "") break;
      if (/^#{1,6}\s+/.test(l)) break;
      if (/^```/.test(l)) break;
      if (/^>\s?/.test(l)) break;
      if (/^\s*([-*+])\s+/.test(l)) break;
      if (/^\s*\d+\.\s+/.test(l)) break;
      if (/^(?:[-*_]){3,}\s*$/.test(l) && !/[^-*_\s]/.test(l)) break;
      paraLines.push(l);
      i++;
    }
    if (paraLines.length > 0) {
      pushBlock(i - paraLines.length, {
        type: "paragraph",
        // Source line breaks are KEPT: the reference hands the paragraph's
        // text token straight to the renderer (marked leaves the soft breaks
        // in it), so a hard-wrapped paragraph keeps the model's line breaks
        // and only over-long lines wrap. Joining with a space re-flows it.
        tokens: tokenizeInline(paraLines.join("\n")),
      });
    }
  }

  return { blocks, blockLineIdx, blockIndentStack };
}

/** Parse a markdown string into blocks (full parse — no line tracking). */
function parseBlocks(input: string): Block[] {
  return parseLines(input.split("\n")).blocks;
}





// ---------------------------------------------------------------------------
// Selection-aware row model. Every text block is pre-wrapped with the same
// wrap-ansi algorithm ink's <Text wrap="wrap"> uses (see lineModel.ts), so
// the model's rows are byte-identical to the rendered cells and mouse
// selection can highlight and copy the exact text on screen.
// ---------------------------------------------------------------------------

function tokensToRuns(tokens: Token[], dim?: boolean, permissionColor?: string): StyledRun[] {
  const runs: StyledRun[] = [];
  for (const tok of tokens) {
    const d: TextStyle | undefined = dim ? { dim: true } : undefined;
    switch (tok.type) {
      case "text":
        runs.push({ text: tok.content, style: d });
        break;
      case "bold":
        runs.push({ text: tok.content, style: { bold: true, ...d } });
        break;
      case "italic":
        runs.push({ text: tok.content, style: { italic: true, ...d } });
        break;
      case "code-inline":
        runs.push({ text: tok.content, style: { color: permissionColor, ...d } });
        break;
      case "link":
        runs.push({ text: tok.content, style: d });
        break;
      default:
        runs.push({ text: tok.content, style: d });
    }
  }
  return runs;
}

/** A blockquote's runs: a dim `▎ ` bar in front of every non-blank source
 *  line, all text italic. The bar is part of the line, exactly as the
 *  reference prefixes it per split line — wrapped continuations belong to
 *  column 0, not to a hanging indent under the bar. */
function blockquoteRuns(
  tokens: Token[],
  dim?: boolean,
  permissionColor?: string,
): StyledRun[] {
  const lines: StyledRun[][] = [[]];
  for (const r of tokensToRuns(tokens, dim, permissionColor)) {
    const parts = r.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      const part = parts[i]!;
      if (part !== "") lines[lines.length - 1]!.push({ text: part, style: r.style });
    }
  }
  const bar: StyledRun = { text: "▎ ", style: { dim: true } };
  const out: StyledRun[] = [];
  lines.forEach((lineRuns, i) => {
    if (i > 0) out.push({ text: "\n" });
    // Blank quote lines keep their row but get no bar (reference: the bar is
    // only added when the line has visible text).
    if (lineRuns.every((r) => r.text.trim() === "")) return;
    out.push(bar);
    for (const r of lineRuns) {
      out.push({ text: r.text, style: { italic: true, ...(r.style ?? {}) } });
    }
  });
  return out;
}

/** Pure line model for a code block (per-line syntax highlight; empty
 *  lines render as a space — matches the previous renderer). */
function codeBlockRows(block: Block, width: number): TextRow[] {
  const lines = (block.content ?? "").split("\n").map((l) => (l === "" ? " " : l));
  const runs: StyledRun[] = [];
  lines.forEach((line, i) => {
    if (i > 0) runs.push({ text: "\n" });
    for (const sp of highlightLine(line, block.language || "")) {
      runs.push({ text: sp.text, style: { color: sp.color, bold: sp.bold } });
    }
  });
  return wrapTextRuns(runs, width);
}

// --- Tables (port of MarkdownTable.tsx) -----------------------------------

/** Minimum column width to prevent degenerate layouts. */
const MIN_COLUMN_WIDTH = 3;
/** Accounts for parent indentation (message prefix) and terminal-resize
 *  races — without enough margin the table overflows its layout box. */
const SAFETY_MARGIN = 4;
/** Above this many wrapped lines per row the reference switches to the
 *  vertical (key/value) layout. */
const MAX_ROW_LINES = 4;

/** Wrap one cell's text to `width`; `hard` splits words longer than the
 *  column (the reference's wrapText(hard) path). */
function wrapCell(text: string, width: number, hard: boolean): string[] {
  const trimmed = text.trimEnd();
  if (width <= 0) return [trimmed];
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const parts: string[] = [];
    if (hard && word.length > width) {
      for (let k = 0; k < word.length; k += width) parts.push(word.slice(k, k + width));
    } else {
      parts.push(word);
    }
    for (const w of parts) {
      if (!cur) cur = w;
      else if (cur.length + 1 + w.length <= width) cur += " " + w;
      else {
        lines.push(cur);
        cur = w;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [""];
}

/** Pad to `targetWidth` according to alignment (reference padAligned). */
function padAlignedText(
  text: string,
  targetWidth: number,
  align: "left" | "center" | "right" | undefined,
): string {
  const padding = Math.max(0, targetWidth - text.length);
  if (align === "center") {
    const leftPad = Math.floor(padding / 2);
    return " ".repeat(leftPad) + text + " ".repeat(padding - leftPad);
  }
  if (align === "right") return " ".repeat(padding) + text;
  return text + " ".repeat(padding);
}

/** `┌───┬───┐` / `├───┼───┤` / `└───┴───┘` (widths + 2 padding per column). */
function tableBorderLine(
  columnWidths: number[],
  type: "top" | "middle" | "bottom",
): StyledRun[] {
  const [left, mid, cross, right] = {
    top: ["┌", "─", "┬", "┐"],
    middle: ["├", "─", "┼", "┤"],
    bottom: ["└", "─", "┴", "┘"],
  }[type] as [string, string, string, string];
  let text = left;
  columnWidths.forEach((w, c) => {
    text += mid.repeat(w + 2);
    text += c < columnWidths.length - 1 ? cross : right;
  });
  return [{ text }];
}

/** Vertical (key/value) layout: bold `Label: value` rows with a 2-space
 *  continuation indent, records separated by a ─ rule. */
function verticalTableLines(
  header: string[],
  rows: string[][],
  terminalWidth: number,
): StyledRun[][] {
  const out: StyledRun[][] = [];
  const separator = "─".repeat(Math.max(0, Math.min(terminalWidth - 1, 40)));
  const wrapIndent = "  ";
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) out.push([{ text: separator }]);
    row.forEach((cell, colIndex) => {
      const label = header[colIndex] || `Column ${colIndex + 1}`;
      // Clean value: trim, collapse internal whitespace/newlines.
      const value = (cell ?? "").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
      // Two-pass wrap: the first line is narrower (the label takes space),
      // continuation lines get the full width minus the indent.
      const firstLineWidth = terminalWidth - label.length - 3;
      const continuationWidth = terminalWidth - wrapIndent.length - 1;
      const firstPass = wrapCell(value, Math.max(firstLineWidth, 10), false);
      const firstLine = firstPass[0] ?? "";
      let wrapped: string[];
      if (firstPass.length <= 1 || continuationWidth <= firstLineWidth) {
        wrapped = firstPass;
      } else {
        const rest = firstPass
          .slice(1)
          .map((l) => l.trim())
          .join(" ");
        wrapped = [firstLine, ...wrapCell(rest, continuationWidth, false)];
      }
      out.push([
        { text: `${label}:`, style: { bold: true } },
        { text: ` ${firstLine}` },
      ]);
      for (let k = 1; k < wrapped.length; k++) {
        const line = wrapped[k]!;
        if (!line.trim()) continue;
        out.push([{ text: `${wrapIndent}${line}` }]);
      }
    });
  });
  return out;
}

/** Box-bordered rows of a markdown table (header, ├─┼─┤ separators between
 *  every row, closing border), or the reference's vertical key/value layout
 *  when the grid would wrap too tall or crowd the terminal edge. */
function tableLines(block: Block, width: number): StyledRun[][] {
  const header = block.header ?? [];
  const rows = block.rows ?? [];
  const cols = header.length;
  if (cols === 0) return [];

  // The reference measures against the terminal; our box can be narrower
  // (message prefix / indentation), so take the tighter of the two.
  const terminalWidth = Math.min(process.stdout.columns || 80, width);

  // Step 1: minimum (longest word) and ideal (whole cell) column widths.
  const minWidths: number[] = [];
  const idealWidths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let min = MIN_COLUMN_WIDTH;
    let ideal = MIN_COLUMN_WIDTH;
    for (const row of [header, ...rows]) {
      const text = row[c] ?? "";
      ideal = Math.max(ideal, text.length);
      for (const word of text.split(/\s+/)) min = Math.max(min, word.length);
    }
    minWidths.push(min);
    idealWidths.push(ideal);
  }

  // Step 2/3: fit the columns into the available space.
  const borderOverhead = 1 + cols * 3; // │ + (2 padding + 1 border) per col
  const availableWidth = Math.max(
    terminalWidth - borderOverhead - SAFETY_MARGIN,
    cols * MIN_COLUMN_WIDTH,
  );
  const total = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const totalMin = total(minWidths);
  const totalIdeal = total(idealWidths);

  let needsHardWrap = false;
  let columnWidths: number[];
  if (totalIdeal <= availableWidth) {
    columnWidths = idealWidths;
  } else if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map((ideal, i) => ideal - minWidths[i]!);
    const totalOverflow = total(overflows);
    columnWidths = minWidths.map((min, i) =>
      totalOverflow === 0
        ? min
        : min + Math.floor((overflows[i]! / totalOverflow) * extraSpace),
    );
  } else {
    // Wider than the terminal even at minimum widths: shrink and break words.
    needsHardWrap = true;
    const scale = availableWidth / totalMin;
    columnWidths = minWidths.map((w) =>
      Math.max(Math.floor(w * scale), MIN_COLUMN_WIDTH),
    );
  }

  const wrapRow = (cells: string[]): string[][] =>
    cells.map((cell, c) => wrapCell(cell ?? "", columnWidths[c] ?? 1, needsHardWrap));

  // Step 4: too many wrapped lines per row → vertical format.
  const headerCells = wrapRow(header);
  const rowCells = rows.map(wrapRow);
  let maxRowLines = 1;
  for (const cellLines of [headerCells, ...rowCells]) {
    for (const lines of cellLines) maxRowLines = Math.max(maxRowLines, lines.length);
  }
  if (maxRowLines > MAX_ROW_LINES) {
    return verticalTableLines(header, rows, terminalWidth);
  }

  // One rendered row: every cell is vertically centred in the row's height.
  const renderRow = (cells: string[][], isHeader: boolean): StyledRun[][] => {
    const maxLines = Math.max(...cells.map((l) => l.length), 1);
    const out: StyledRun[][] = [];
    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      let text = "│";
      for (let c = 0; c < cols; c++) {
        const cellLines = cells[c] ?? [];
        const offset = Math.floor((maxLines - cellLines.length) / 2);
        const idx = lineIdx - offset;
        const line = idx >= 0 && idx < cellLines.length ? cellLines[idx]! : "";
        // Headers always centred; data uses the column's alignment.
        const align = isHeader ? "center" : block.align?.[c] ?? "left";
        text += " " + padAlignedText(line, columnWidths[c] ?? 0, align) + " │";
      }
      out.push([{ text }]);
    }
    return out;
  };

  const out: StyledRun[][] = [];
  out.push(tableBorderLine(columnWidths, "top"));
  out.push(...renderRow(headerCells, true));
  out.push(tableBorderLine(columnWidths, "middle"));
  rowCells.forEach((cells, r) => {
    out.push(...renderRow(cells, false));
    if (r < rowCells.length - 1) out.push(tableBorderLine(columnWidths, "middle"));
  });
  out.push(tableBorderLine(columnWidths, "bottom"));

  // Safety check: nothing may come within SAFETY_MARGIN of the edge.
  const maxLineWidth = Math.max(
    ...out.map((runs) => runs.reduce((n, r) => n + r.text.length, 0)),
  );
  if (maxLineWidth > terminalWidth - SAFETY_MARGIN) {
    return verticalTableLines(header, rows, terminalWidth);
  }
  return out;
}

function tableRows(block: Block, width: number): TextRow[] {
  const lines = tableLines(block, width);
  if (lines.length === 0) return [];
  const runs: StyledRun[] = [];
  lines.forEach((line, i) => {
    if (i > 0) runs.push({ text: "\n" });
    runs.push(...line);
  });
  return wrapTextRuns(runs, width);
}

const SPACER: TextRow = { runs: [], softWrapped: false };

export interface MarkdownBlockRows {
  block: Block;
  rows: TextRow[];
  /** Extra blank rows after this block (heading marginBottom + gap). */
  spacersAfter: number;
}

/** Parse + wrap a markdown string into the exact rows ink renders for it
 *  (used by Markdown for rendering and by ChatPanel for copy extraction). */
/** Wrap one parsed block into its row model. */
function wrapBlockRows(
  block: Block,
  width: number,
  dim: boolean | undefined,
  permissionColor: string | undefined,
): MarkdownBlockRows {
  let rows: TextRow[];
  switch (block.type) {
    case "paragraph":
      rows = wrapTextRuns(tokensToRuns(block.tokens ?? [], dim, permissionColor), width);
      break;
    case "heading": {
      const level = block.level ?? 1;
      // h1 is bold + italic + underline; h2 and deeper are bold only.
      const style: TextStyle =
        level >= 2 ? { bold: true } : { bold: true, italic: true, underline: true };
      if (dim) style.dim = true;
      const runs = (block.tokens ?? []).map((t) => ({ text: t.content, style }));
      rows = wrapTextRuns(runs, width);
      break;
    }
    case "code-block":
      rows = codeBlockRows(block, width);
      break;
    case "list-item": {
      const depth = block.indent ?? 0;
      const bullet = block.ordered ? `${getListNumber(depth, block.index ?? 1)}.` : "-";
      // The indent belongs to the LINE, so a wrapped continuation starts at
      // column 0 instead of hanging under the bullet. The reference's
      // list_item prepends `'  '.repeat(listDepth)` to EVERY child and
      // recurses with listDepth + 1; marked nests a sub-list inside its
      // parent item's tokens (list_item → [text, list]), so each level's
      // prefix stacks on the previous one — but only for the FIRST line of a
      // nested list, since the child string is multi-line. The rendered
      // indents are therefore 0, 2, 6, 10, 14 … (2 at the first level, +4
      // per level after that; measured on the reference's formatToken with
      // marked 15.0.12 for seven levels).
      const indent = depth === 0 ? 0 : 4 * depth - 2;
      const runs: StyledRun[] = [
        { text: `${" ".repeat(indent)}${bullet} ` },
        ...tokensToRuns(block.tokens ?? [], dim, permissionColor),
      ];
      rows = wrapTextRuns(runs, width);
      break;
    }
    case "blockquote":
      rows = wrapTextRuns(blockquoteRuns(block.tokens ?? [], dim, permissionColor), width);
      break;
    case "hr":
      rows = [{ runs: [{ text: "---" }], softWrapped: false }];
      break;
    case "table":
      rows = tableRows(block, width);
      break;
    default:
      rows = wrapTextRuns(tokensToRuns(block.tokens ?? [], dim, permissionColor), width);
    }
    // The reference's heading token emits one EOL and the space token that
    // follows it supplies the other blank row, so a heading gets exactly the
    // one inter-block spacer row every other block gets.
    return { block, rows, spacersAfter: 0 };
}

/**
 * Streaming markdown state: the parsed+wrapped model plus the source line
 * index of each block's first line. Because parseBlocks only ever changes
 * the LAST block when text is appended, consecutive renders of a growing
 * stream re-parse just the tail — turning the naive O(n^2) full re-parse
 * per 80ms flush into O(appended tail).
 */
export interface MarkdownModelState {
  /** Source content the model was parsed from (append-only during streaming). */
  content: string;
  width: number;
  dim?: boolean;
  permissionColor?: string;
  /** Wrapped blocks. Unchanged blocks keep object identity across updates
   *  so memoized per-block rendering can bail out. */
  model: MarkdownBlockRows[];
  /** Source line index of each block's first line. */
  blockLineIdx: number[];
  /** List indent stack in effect at each block's first line, so a tail
   *  re-parse can resume with the nesting context the full parse had. */
  blockIndentStack: number[][];
}

/**
 * Update (or build) a markdown model for `content`. Pass the previous state
 * to reuse the parse when the content only grew; pass null for a full parse.
 * Idempotent for repeated calls with the same content (returns the state
 * unchanged) — safe to call during render.
 */
export function updateMarkdownModel(
  content: string,
  width: number,
  dim: boolean | undefined,
  permissionColor: string | undefined,
  state: MarkdownModelState | null,
): MarkdownModelState {
  if (
    state &&
    state.content === content &&
    state.width === width &&
    state.dim === dim &&
    state.permissionColor === permissionColor
  ) {
    return state;
  }
  const lines = content.split("\n");

  if (
    state &&
    state.width === width &&
    state.dim === dim &&
    state.permissionColor === permissionColor &&
    state.model.length > 0 &&
    content.startsWith(state.content)
  ) {
    // Append-only: re-parse from the last block's first source line. The
    // previous blocks are untouched (their line offsets stay valid because
    // appending never shifts earlier lines).
    const lastIdx = state.model.length - 1;
    const tailLine = state.blockLineIdx[lastIdx]!;
    // Seed with the list nesting the last block was parsed under: list depth
    // spans lines, so a tail parse that restarts the stack would indent the
    // re-parsed items differently from the full parse.
    const { blocks, blockLineIdx, blockIndentStack } = parseLines(
      lines.slice(tailLine),
      state.blockIndentStack[lastIdx] ?? [],
    );
    if (blocks.length > 0) {
      const model = state.model.slice(0, lastIdx);
      const newBlockLineIdx = state.blockLineIdx.slice(0, lastIdx);
      const newBlockIndentStack = state.blockIndentStack.slice(0, lastIdx);
      for (let i = 0; i < blocks.length; i++) {
        newBlockLineIdx.push(tailLine + (blockLineIdx[i] ?? 0));
        newBlockIndentStack.push(blockIndentStack[i] ?? []);
        model.push(wrapBlockRows(blocks[i]!, width, dim, permissionColor));
      }
      state.model = model;
      state.blockLineIdx = newBlockLineIdx;
      state.blockIndentStack = newBlockIndentStack;
    }
    // else: trailing blank lines only — the model is already correct.
    state.content = content;
    return state;
  }

  const parsed = parseLines(lines);
  const model: MarkdownBlockRows[] = [];
  for (const block of parsed.blocks) {
    model.push(wrapBlockRows(block, width, dim, permissionColor));
  }
  return {
    content,
    width,
    dim,
    permissionColor,
    model,
    blockLineIdx: parsed.blockLineIdx,
    blockIndentStack: parsed.blockIndentStack,
  };
}

/** Full parse + wrap (no incremental state) — convenience wrapper. */
export function markdownRows(
  content: string,
  width: number,
  dim?: boolean,
  permissionColor?: string,
): MarkdownBlockRows[] {
  return updateMarkdownModel(content, width, dim, permissionColor, null).model;
}

/** Total rendered rows of a markdownRows() result (rows + spacers). */
export function markdownTotalRows(model: MarkdownBlockRows[]): number {
  return flattenMarkdown(model).length;
}

/** Blank row between two blocks? The reference's `hr` token is a bare `---`
 *  with no EOL of its own — the blank line above a rule comes from the space
 *  token before it — so nothing is blank-padded after a horizontal rule. */
function hasGapBefore(model: MarkdownBlockRows[], i: number): boolean {
  return i > 0 && model[i - 1]!.block.type !== "hr";
}

/** Flatten a markdownRows() result into one row list including spacer rows
 *  (used for copy extraction and row accounting). */
export function flattenMarkdown(model: MarkdownBlockRows[]): TextRow[] {
  const out: TextRow[] = [];
  for (let i = 0; i < model.length; i++) {
    if (hasGapBefore(model, i)) out.push(SPACER);
    out.push(...model[i]!.rows);
    for (let s = 0; s < (model[i]!.spacersAfter ?? 0); s++) out.push(SPACER);
  }
  return out;
}

/** Selection columns ([start, end), content-relative) covered at a global
 *  content row, accounting for the row's column origin. Returns null when
 *  the row is outside the selection. */
export function rowSelection(
  selection: ContentSelection | null,
  globalRow: number,
  origin: number,
  width: number,
): [number, number] | null {
  if (!selection) return null;
  if (globalRow < selection.startRow || globalRow > selection.endRow) return null;
  const startCol = (globalRow === selection.startRow ? selection.startCol : 0) - origin;
  const endCol = (globalRow === selection.endRow ? selection.endCol : width) - origin;
  const avail = width - origin;
  return [
    Math.max(0, Math.min(startCol, avail)),
    Math.max(0, Math.min(endCol, avail)),
  ];
}

/** One model row rendered with optional selection highlight. `selCols` are
 *  block-content-relative [start, end) columns (already minus origin). */
export function RowText({
  row,
  selCols,
  rowWidth,
  dim,
}: {
  row: TextRow;
  selCols: [number, number] | null;
  rowWidth: number;
  dim?: boolean;
}): React.ReactElement {
  const bg = resolveColor(theme.selectionBg);
  const text = rowText(row);
  const selActive = selCols !== null && selCols[1] > selCols[0];
  if (text.length === 0) {
    // Blank row (spacer / gap): highlight the covered width.
    if (selActive) {
      const origin = row.origin ?? 0;
      const from = Math.max(0, selCols![0]);
      const to = Math.min(rowWidth - origin, selCols![1]);
      const n = Math.max(1, to - from);
      return (
        <Text dimColor={dim} backgroundColor={bg}>
          {" ".repeat(n)}
        </Text>
      );
    }
    return <Text dimColor={dim}>{" "}</Text>;
  }
  // `selected` runs drop their own backgroundColor so the selection highlight
  // (selectionBg) shows instead of the diff/token background.
  const runEls = (runs: StyledRun[], k: string, selected = false): React.ReactNode =>
    runs.map((r, i) => (
      <Text
        key={`${k}${i}`}
        bold={r.style?.bold}
        italic={r.style?.italic}
        underline={r.style?.underline}
        dimColor={r.style?.dim}
        color={r.style?.color}
        backgroundColor={selected ? undefined : r.style?.backgroundColor}
      >
        {r.text}
      </Text>
    ));
  if (!selActive) {
    return <Text dimColor={dim}>{runEls(row.runs, "t")}</Text>;
  }
  const { before, selected, after } = splitRowAt(row, selCols![0], selCols![1]);
  return (
    <Text dimColor={dim}>
      {runEls(before, "b")}
      {selected.length > 0 && <Text backgroundColor={bg}>{runEls(selected, "s", true)}</Text>}
      {runEls(after, "a")}
    </Text>
  );
}

/** A fixed 1-row-tall box holding one model row (guarantees every model
 *  row occupies exactly one screen row regardless of text length). */
function RowBox({
  row,
  selCols,
  width,
  dim,
}: {
  row: TextRow;
  selCols: [number, number] | null;
  width: number;
  dim?: boolean;
}): React.ReactElement {
  return (
    <Box height={1} flexShrink={0} minWidth={0}>
      <RowText row={row} selCols={selCols} rowWidth={width} dim={dim} />
    </Box>
  );
}

function numberToLetter(n: number): string {
  let result = "";
  while (n > 0) {
    n--;
    result = String.fromCharCode(97 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function numberToRoman(n: number): string {
  let result = "";
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral;
      n -= value;
    }
  }
  return result;
}

/** Ordered-list marker for a nesting depth: decimal at the top level, then
 *  letters, then roman numerals (reference getListNumber, which is called
 *  with the same depth+1 the reference's list_item passes down). */
function getListNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 1:
      return numberToLetter(orderedListNumber);
    case 2:
      return numberToRoman(orderedListNumber);
    default:
      return orderedListNumber.toString();
  }
}

interface MarkdownProps {
  children: string;
  dim?: boolean;
  /** Content width (cols) available to this markdown box. */
  width: number;
  /** Active selection in content coordinates (rows inclusive), or null. */
  selection?: ContentSelection | null;
  /** Global content row where this markdown box begins. */
  startRow?: number;
  /** Column offset of this box's left edge within the content area
   *  ("● " / "❯ " prefix or padding shifts the markdown right). */
  leftOffset?: number;
  /** Pre-built model (from MessageView's shared incremental state). When
   *  provided, parsing is skipped entirely — the caller guarantees it
   *  matches `children`. */
  model?: MarkdownBlockRows[];
}

/**
 * One markdown block rendered from pre-wrapped rows. Memoized on the block
 * object + row array identity: during streaming, blocks before the last one
 * keep their identity (see updateMarkdownModel), so unchanged blocks skip
 * re-rendering entirely on every 80ms flush.
 */
const MemoBlock = React.memo(function MemoBlock({
  block,
  rows,
  spacersAfter,
  width,
  dim,
  leftOffset,
  blockStart,
  selection,
}: {
  block: Block;
  rows: TextRow[];
  spacersAfter: number;
  width: number;
  dim?: boolean;
  leftOffset: number;
  blockStart: number;
  selection: ContentSelection | null;
}): React.ReactElement {
  const selColsAt = (globalRow: number, origin: number): [number, number] | null =>
    rowSelection(selection, globalRow, origin + leftOffset, width + leftOffset);

  const rowEls = (offsetOrigin: number) =>
    rows.map((r, i) => (
      <RowBox
        key={`r${i}`}
        row={r}
        selCols={selColsAt(blockStart + i, r.origin ?? offsetOrigin)}
        width={width}
        dim={dim}
      />
    ));

  const spacerEls: React.ReactNode[] = [];
  for (let s = 0; s < spacersAfter; s++) {
    const sr = blockStart + rows.length + s;
    spacerEls.push(
      <RowBox key={`sp${s}`} row={SPACER} selCols={selColsAt(sr, 0)} width={width} dim={dim} />,
    );
  }

  // Blockquotes and list items carry their bar / indent in the row text
  // (see blockquoteRuns and the list-item case in wrapBlockRows), so every
  // block is a plain column of rows.
  const inner: React.ReactNode = (
    <Box flexDirection="column" minWidth={0}>
      {rowEls(0)}
    </Box>
  );
  return (
    <Box flexDirection="column" flexShrink={0}>
      {inner}
      {spacerEls}
    </Box>
  );
});

export default function Markdown({
  children,
  dim,
  width,
  selection,
  startRow = 0,
  leftOffset = 0,
  model: modelProp,
}: MarkdownProps): React.ReactElement {
  const permissionColor = resolveColor(theme.permission);
  // Incremental parse state: survives renders in a ref so a growing
  // streaming content only re-parses its tail (updateMarkdownModel is
  // idempotent for repeated input, so render-time mutation is safe).
  const stateRef = useRef<MarkdownModelState | null>(null);
  const model: MarkdownModelState | MarkdownBlockRows[] = modelProp !== undefined
    ? modelProp
    : updateMarkdownModel(children, width, dim, permissionColor, stateRef.current);
  if (modelProp === undefined) stateRef.current = model as MarkdownModelState;
  const modelRows: MarkdownBlockRows[] = modelProp !== undefined ? modelProp : (model as MarkdownModelState).model;

  const selColsAt = (globalRow: number, origin: number): [number, number] | null =>
    rowSelection(selection ?? null, globalRow, origin + leftOffset, width + leftOffset);

  const fragments: React.ReactNode[] = [];
  let row = startRow;
  modelRows.forEach((b, bi) => {
    if (hasGapBefore(modelRows, bi)) {
      fragments.push(
        <RowBox key={`sp${bi}`} row={SPACER} selCols={selColsAt(row, 0)} width={width} dim={dim} />,
      );
      row++;
    }
    const blockStart = row;
    fragments.push(
      <MemoBlock
        key={`b${bi}`}
        block={b.block}
        rows={b.rows}
        spacersAfter={b.spacersAfter ?? 0}
        width={width}
        dim={dim}
        leftOffset={leftOffset}
        blockStart={blockStart}
        selection={selection ?? null}
      />,
    );
    row = blockStart + b.rows.length;
    for (let s = 0; s < (b.spacersAfter ?? 0); s++) row++;
  });

  return <Box flexDirection="column" flexShrink={0}>{fragments}</Box>;
}