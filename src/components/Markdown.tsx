// Rich Markdown rendering for Ink terminal UI
// Parses markdown via regex and renders with proper terminal formatting.
// No external dependencies — only uses ink (Text, Box) + React.

import React, { useMemo } from "react";
import { Text, Box } from "ink";
import { theme } from "../utils/theme.js";
import { highlightLine } from "./codeHighlight.js";

// ---------------------------------------------------------------------------
// Token types — inline elements produced by the tokenizer
// ---------------------------------------------------------------------------

type TokenType = "text" | "bold" | "italic" | "code-inline" | "link";

interface Token {
  type: TokenType;
  content: string;
  href?: string;
}

// ---------------------------------------------------------------------------
// Block types — structural elements produced by the block parser
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Inline tokenizer — handles bold, italic, code, links
// ---------------------------------------------------------------------------

/**
 * Ordered list of inline patterns. Order matters:
 *   1. Inline code (backtick-delimited, greedy)
 *   2. Links [text](url)
 *   3. Bold+italic ***text***
 *   4. Bold **text**
 *   5. Italic *text*
 *   6. Italic (alternate) _text_
 */
const INLINE_PATTERNS: readonly {
  regex: RegExp;
  type: TokenType;
  group: (m: RegExpMatchArray) => { content: string; href?: string };
}[] = [
  {
    // Inline code: `code` or ``code``
    regex: /^(`+)([\s\S]*?)\1/,
    type: "code-inline",
    group: (m) => ({ content: m[2] ?? "" }),
  },
  {
    // Links: [text](url)
    regex: /^\[([^\]]*)\]\(([^)]*)\)/,
    type: "link",
    group: (m) => ({ content: m[1] ?? "", href: m[2] ?? "" }),
  },
  {
    // Bold + italic: ***text***
    regex: /^\*\*\*([\s\S]+?)\*\*\*/,
    type: "bold",
    group: (m) => ({ content: m[1] ?? "" }),
  },
  {
    // Bold: **text**
    regex: /^\*\*([\s\S]+?)\*\*/,
    type: "bold",
    group: (m) => ({ content: m[1] ?? "" }),
  },
  {
    // Italic: *text*
    regex: /^\*(?!\s)([\s\S]+?)(?<!\s)\*/,
    type: "italic",
    group: (m) => ({ content: m[1] ?? "" }),
  },
  {
    // Italic (alternate): _text_
    regex: /^_(?!\s)([\s\S]+?)(?<!\s)_/,
    type: "italic",
    group: (m) => ({ content: m[1] ?? "" }),
  },
];

/** Characters that can start an inline pattern — used for fast skip. */
const SPECIAL_CHARS = new Set(["`", "[", "*", "_"]);

/**
 * Special-char proximity lookup: precompute the index of the next special
 * character from every position so the plain-text accumulation loop can jump
 * forward instead of checking one character at a time.
 */
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

    // Only attempt pattern matching at special characters for speed
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
      // Fast-forward through plain text to the next special character
      const start = i;
      i = nextSpecialFrom(text, start + 1);
      // But verify that the special character actually starts a pattern — if
      // not, include it in the plain text and advance.
      // We already know position `start` did not match, so include it.
      tokens.push({ type: "text", content: text.slice(start, i) });

      // If we landed on a special char that doesn't match any pattern we'll
      // catch it on the next iteration and it'll be consumed as a single-char
      // text token — but first let's extend the plain text greedily by checking
      // whether the special char actually triggers a match.
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
          // Not a real delimiter — include it and keep scanning
          i++;
        }
      }
    }
  }

  return mergeTextTokens(tokens);
}

/** Merge adjacent plain-text tokens for fewer React elements. */
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

// ---------------------------------------------------------------------------
// Block parser — splits raw markdown into structured blocks
// ---------------------------------------------------------------------------

function parseBlocks(input: string): Block[] {
  const lines = input.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // --- Empty line (paragraph separator) ---
    if (line.trim() === "") {
      i++;
      continue;
    }

    // --- Horizontal rule: --- or *** or ___ (3+ chars, nothing else) ---
    if (/^(?:[-*_]){3,}\s*$/.test(line) && !/[^-*_\s]/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // --- Fenced code block: ```lang ... ``` ---
    const fenceMatch = line.match(/^```(\S*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      blocks.push({
        type: "code-block",
        language: lang || undefined,
        content: codeLines.join("\n"),
      });
      continue;
    }

    // --- Heading: # ## ### etc ---
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

    // --- Blockquote: > text ---
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

    // --- Unordered list: - item, * item, + item ---
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

    // --- Ordered list: 1. item ---
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

    // --- GFM table: header row | separator row | data rows ---
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

    // --- Paragraph: collect consecutive non-special lines ---
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
// Inline token renderer
// ---------------------------------------------------------------------------

function renderTokens(
  tokens: Token[],
  parentKey: string,
  dim?: boolean,
): React.ReactNode[] {
  return tokens.map((tok, idx) => {
    const key = `${parentKey}-t${idx}`;

    switch (tok.type) {
      case "text":
        return (
          <Text key={key} dimColor={dim} wrap="wrap">
            {tok.content}
          </Text>
        );
      case "bold":
        return (
          <Text key={key} bold dimColor={dim} wrap="wrap">
            {tok.content}
          </Text>
        );
      case "italic":
        return (
          <Text key={key} italic dimColor={dim} wrap="wrap">
            {tok.content}
          </Text>
        );
      case "code-inline":
        return (
          <Text key={key} color={theme.warning} dimColor wrap="wrap">
            {tok.content}
          </Text>
        );
      case "link":
        return (
          <Text key={key} color={theme.assistant} wrap="wrap">
            {tok.content}
          </Text>
        );
      default:
        return (
          <Text key={key} wrap="wrap">
            {tok.content}
          </Text>
        );
    }
  });
}

// ---------------------------------------------------------------------------
// Block renderers — one function per block type
// ---------------------------------------------------------------------------

function renderHeading(block: Block, key: string): React.ReactNode {
  return (
    <Box key={key} flexDirection="column">
      <Text bold wrap="wrap">
        {renderTokens(block.tokens ?? [], key, false)}
      </Text>
    </Box>
  );
}

function renderCodeBlock(block: Block, key: string): React.ReactNode {
  const lang = block.language || "";
  const content = block.content ?? "";
  const lines = content.split("\n");

  return (
    <Box key={key} flexDirection="column">
      <Text dimColor>
        {"── "}
        <Text dimColor bold>
          {lang || "code"}
        </Text>
        {" ──"}
      </Text>
      {lines.map((line, i) => {
        const spans = highlightLine(line, lang);
        return (
          <Text key={`${key}-cl-${i}`} wrap="wrap">
            {line === ""
              ? " "
              : spans.map((sp, j) => (
                  <Text key={`${key}-cl-${i}-s${j}`} color={sp.color} bold={sp.bold}>
                    {sp.text}
                  </Text>
                ))}
          </Text>
        );
      })}
      <Text dimColor>{"──"}</Text>
    </Box>
  );
}

function renderListItem(block: Block, key: string): React.ReactNode {
  const indent = block.indent ?? 0;
  const bullet = block.ordered ? `${block.index ?? 1}.` : "\u2022";
  const leftPad = indent * 2;

  return (
    <Box key={key} marginLeft={leftPad}>
      <Text>
        {bullet} {renderTokens(block.tokens ?? [], key, false)}
      </Text>
    </Box>
  );
}

function renderBlockquote(block: Block, key: string): React.ReactNode {
  return (
    <Box key={key}>
      <Text color={theme.subtle}>{"\u2502 "}</Text>
      <Text wrap="wrap">{renderTokens(block.tokens ?? [], key, false)}</Text>
    </Box>
  );
}

function renderHR(key: string): React.ReactNode {
  return (
    <Text key={key} dimColor>
      {"\u2500".repeat(40)}
    </Text>
  );
}

function renderParagraph(
  block: Block,
  key: string,
  dim?: boolean,
): React.ReactNode {
  return (
    <Box key={key}>
      <Text wrap="wrap">{renderTokens(block.tokens ?? [], key, dim)}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// ── Word-wrap helper for table cells ────────────────────────────────────────

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

function renderTable(block: Block, key: string): React.ReactNode {
  const header = block.header ?? [];
  const rows = block.rows ?? [];
  const align = block.align ?? [];
  const cols = header.length;
  if (cols === 0) return null;

  const termWidth = process.stdout.columns || 80;
  const sepOverhead = Math.max(0, cols - 1) * 3; // " │ " between columns
  const avail = Math.max(20, termWidth - sepOverhead);

  // Natural column widths, shrunk proportionally to fit the terminal.
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

  const headerLines = renderCells(header);
  const sep = widths.map((w) => "─".repeat(w)).join("─┼─");

  return (
    <Box key={key} flexDirection="column" marginY={0}>
      {headerLines.map((l, i) => (
        <Text key={`${key}-h-${i}`} bold>
          {l}
        </Text>
      ))}
      <Text dimColor>{sep}</Text>
      {rows.map((row, ri) =>
        renderCells(row).map((l, li) => (
          <Text key={`${key}-r${ri}-${li}`} wrap="truncate">
            {l}
          </Text>
        )),
      )}
    </Box>
  );
}

interface MarkdownProps {
  children: string;
  dim?: boolean;
}

export default function Markdown({
  children,
  dim,
}: MarkdownProps): React.ReactElement {
  // Memoize block parsing so we don't re-parse on every render
  const blocks = useMemo(() => parseBlocks(children), [children]);

  return (
    <Box flexDirection="column">
      {blocks.map((block, idx) => {
        const key = `b${idx}`;
        switch (block.type) {
          case "heading":
            return renderHeading(block, key);
          case "code-block":
            return renderCodeBlock(block, key);
          case "list-item":
            return renderListItem(block, key);
          case "blockquote":
            return renderBlockquote(block, key);
          case "hr":
            return renderHR(key);
          case "table":
            return renderTable(block, key);
          case "paragraph":
          default:
            return renderParagraph(block, key, dim);
        }
      })}
    </Box>
  );
}
