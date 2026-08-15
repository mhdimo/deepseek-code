















import React, { useMemo } from "react";
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





function parseBlocks(input: string): Block[] {
  const lines = input.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    
    if (line.trim() === "") {
      i++;
      continue;
    }

    
    if (/^(?:[-*_]){3,}\s*$/.test(line) && !/[^-*_\s]/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    
    const fenceMatch = line.match(/^```(\S*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; 
      blocks.push({
        type: "code-block",
        language: lang || undefined,
        content: codeLines.join("\n"),
      });
      continue;
    }

    
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const content = headingMatch[2]!.replace(/\s*#+\s*$/, "");
      blocks.push({
        type: "heading",
        level,
        tokens: tokenizeInline(content),
      });
      i++;
      continue;
    }

    
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      for (const ql of quoteLines) {
        blocks.push({
          type: "blockquote",
          tokens: tokenizeInline(ql),
        });
      }
      continue;
    }

    
    if (/^\s*([-*+])\s+/.test(line)) {
      while (i < lines.length) {
        const liMatch = lines[i]?.match(/^(\s*)([-*+])\s+(.+)$/);
        if (!liMatch) break;
        const indentLevel = Math.floor(liMatch[1]!.length / 2);
        blocks.push({
          type: "list-item",
          indent: indentLevel,
          ordered: false,
          tokens: tokenizeInline(liMatch[3]!),
        });
        i++;
      }
      continue;
    }

    
    if (/^\s*\d+\.\s+/.test(line)) {
      let idx = 1;
      while (i < lines.length) {
        const liMatch = lines[i]?.match(/^(\s*)(\d+)\.\s+(.+)$/);
        if (!liMatch) break;
        const indentLevel = Math.floor(liMatch[1]!.length / 2);
        blocks.push({
          type: "list-item",
          indent: indentLevel,
          ordered: true,
          index: idx,
          tokens: tokenizeInline(liMatch[3]!),
        });
        idx++;
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
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      blocks.push({ type: "table", header, align, rows });
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
      blocks.push({
        type: "paragraph",
        tokens: tokenizeInline(paraLines.join(" ")),
      });
    }
  }

  return blocks;
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

/** Wrap a block's runs at `width`, marking each row's column origin
 *  (blockquote prefix / list indent). */
function wrapBlock(runs: StyledRun[], width: number, origin: number): TextRow[] {
  const rows = wrapTextRuns(runs, Math.max(1, width - origin));
  for (const r of rows) r.origin = origin;
  return rows;
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

/** Padded cell rows of a table; the header row is bold, the separator dim. */
function tableLines(block: Block): { text: string; bold?: boolean; dim?: boolean }[] {
  const header = block.header ?? [];
  const rows = block.rows ?? [];
  const align = block.align ?? [];
  const cols = header.length;
  if (cols === 0) return [];

  const termWidth = process.stdout.columns || 80;
  const sepOverhead = Math.max(0, cols - 1) * 3;
  const avail = Math.max(20, termWidth - sepOverhead);

  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = header[c]?.length ?? 0;
    for (const r of rows) w = Math.max(w, r[c]?.length ?? 0);
    widths.push(w);
  }
  const sum = (): number => widths.reduce((a, b) => a + b, 0);
  if (sum() > avail) {
    const total = sum();
    for (let c = 0; c < cols; c++) {
      widths[c] = Math.max(6, Math.floor(((widths[c] ?? 6) * avail) / Math.max(1, total)));
    }
    while (sum() > avail) {
      let mi = 0;
      for (let c = 0; c < cols; c++) if ((widths[c] ?? 0) > (widths[mi] ?? 0)) mi = c;
      widths[mi] = Math.max(6, (widths[mi] ?? 6) - 1);
    }
  }

  const padCell = (s: string, c: number): string => {
    const w = widths[c] ?? 0;
    const a = align[c];
    if (a === "right") return s.padStart(w);
    if (a === "center") {
      const t = Math.max(0, w - s.length);
      return " ".repeat(Math.floor(t / 2)) + s + " ".repeat(t - Math.floor(t / 2));
    }
    return s.padEnd(w);
  };

  const renderCells = (cells: string[]): string[] => {
    const wrapped = cells.map((cell, c) => wrapWords(cell ?? "", widths[c] ?? 1));
    const maxLines = Math.max(...wrapped.map((w) => w.length));
    const out: string[] = [];
    for (let li = 0; li < maxLines; li++) {
      out.push(cells.map((_, c) => padCell(wrapped[c]![li] ?? "", c)).join(" │ "));
    }
    return out;
  };

  const out: { text: string; bold?: boolean; dim?: boolean }[] = [];
  for (const l of renderCells(header)) out.push({ text: l, bold: true });
  out.push({ text: widths.map((w) => "─".repeat(w)).join("─┼─"), dim: true });
  for (const row of rows) {
    for (const l of renderCells(row)) out.push({ text: l });
  }
  return out;
}

function tableRows(block: Block, width: number): TextRow[] {
  const lines = tableLines(block);
  const runs: StyledRun[] = [];
  lines.forEach((line, i) => {
    if (i > 0) runs.push({ text: "\n" });
    runs.push({
      text: line.text,
      style: line.bold ? { bold: true } : line.dim ? { dim: true } : undefined,
    });
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
export function markdownRows(
  content: string,
  width: number,
  dim?: boolean,
  permissionColor?: string,
): MarkdownBlockRows[] {
  const blocks = parseBlocks(content);
  const out: MarkdownBlockRows[] = [];
  for (const block of blocks) {
    let rows: TextRow[];
    switch (block.type) {
      case "paragraph":
        rows = wrapTextRuns(tokensToRuns(block.tokens ?? [], dim, permissionColor), width);
        break;
      case "heading": {
        const level = block.level ?? 1;
        const style: TextStyle = level >= 2 ? { bold: true } : { italic: true, underline: true };
        if (dim) style.dim = true;
        const runs = (block.tokens ?? []).map((t) => ({ text: t.content, style }));
        rows = wrapTextRuns(runs, width);
        break;
      }
      case "code-block":
        rows = codeBlockRows(block, width);
        break;
      case "list-item": {
        const indent = block.indent ?? 0;
        const leftPad = indent * 2;
        const bullet = block.ordered ? `${getListNumber(indent, block.index ?? 1)}.` : "-";
        const runs: StyledRun[] = [
          { text: `${bullet} ` },
          ...tokensToRuns(block.tokens ?? [], dim, permissionColor),
        ];
        rows = wrapBlock(runs, width, leftPad);
        break;
      }
      case "blockquote": {
        const runs = tokensToRuns(block.tokens ?? [], dim, permissionColor);
        for (const r of runs) r.style = { italic: true, ...(r.style ?? {}) };
        rows = wrapBlock(runs, width, 2);
        break;
      }
      case "hr":
        rows = [{ runs: [{ text: "---" }], softWrapped: false }];
        break;
      case "table":
        rows = tableRows(block, width);
        break;
      default:
        rows = wrapTextRuns(tokensToRuns(block.tokens ?? [], dim, permissionColor), width);
    }
    // heading's marginBottom={1} plus the flex gap between blocks = 2
    // spacer rows after it; other blocks contribute 1 gap row each.
    out.push({ block, rows, spacersAfter: block.type === "heading" ? 2 : 0 });
  }
  return out;
}

/** Total rendered rows of a markdownRows() result (rows + spacers). */
export function markdownTotalRows(model: MarkdownBlockRows[]): number {
  return flattenMarkdown(model).length;
}

/** Flatten a markdownRows() result into one row list including spacer rows
 *  (used for copy extraction and row accounting). */
export function flattenMarkdown(model: MarkdownBlockRows[]): TextRow[] {
  const out: TextRow[] = [];
  for (let i = 0; i < model.length; i++) {
    if (i > 0) out.push(SPACER);
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

function getListNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 2:
      return numberToLetter(orderedListNumber);
    case 3:
      return numberToRoman(orderedListNumber);
    default:
      return orderedListNumber.toString();
  }
}

function wrapWords(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += " " + w;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
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
}

export default function Markdown({
  children,
  dim,
  width,
  selection,
  startRow = 0,
  leftOffset = 0,
}: MarkdownProps): React.ReactElement {
  const permissionColor = resolveColor(theme.permission);
  const model = useMemo(
    () => markdownRows(children, width, dim, permissionColor),
    [children, width, dim, permissionColor],
  );

  const selColsAt = (globalRow: number, origin: number): [number, number] | null =>
    rowSelection(selection ?? null, globalRow, origin + leftOffset, width + leftOffset);

  const fragments: React.ReactNode[] = [];
  let row = startRow;
  model.forEach((b, bi) => {
    if (bi > 0) {
      fragments.push(
        <RowBox key={`sp${bi}`} row={SPACER} selCols={selColsAt(row, 0)} width={width} dim={dim} />,
      );
      row++;
    }
    const blockStart = row;
    let inner: React.ReactNode;
    switch (b.block.type) {
      case "blockquote":
        inner = (
          <Box flexDirection="row" minWidth={0}>
            <Text dimColor>{"▎ "}</Text>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              {b.rows.map((r, i) => (
                <RowBox
                  key={`r${i}`}
                  row={r}
                  selCols={selColsAt(blockStart + i, r.origin ?? 0)}
                  width={width}
                  dim={dim}
                />
              ))}
            </Box>
          </Box>
        );
        break;
      case "list-item":
        inner = (
          <Box
            marginLeft={(b.block.indent ?? 0) * 2}
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
          >
            {b.rows.map((r, i) => (
              <RowBox
                key={`r${i}`}
                row={r}
                selCols={selColsAt(blockStart + i, r.origin ?? 0)}
                width={width}
                dim={dim}
              />
            ))}
          </Box>
        );
        break;
      default:
        inner = (
          <Box flexDirection="column" minWidth={0}>
            {b.rows.map((r, i) => (
              <RowBox
                key={`r${i}`}
                row={r}
                selCols={selColsAt(blockStart + i, r.origin ?? 0)}
                width={width}
                dim={dim}
              />
            ))}
          </Box>
        );
    }
    fragments.push(
      <Box key={`b${bi}`} flexDirection="column" flexShrink={0}>
        {inner}
      </Box>,
    );
    row = blockStart + b.rows.length;
    for (let s = 0; s < (b.spacersAfter ?? 0); s++) {
      fragments.push(
        <RowBox key={`sp${bi}-${s}`} row={SPACER} selCols={selColsAt(row, 0)} width={width} dim={dim} />,
      );
      row++;
    }
  });

  return <Box flexDirection="column" flexShrink={0}>{fragments}</Box>;
}
