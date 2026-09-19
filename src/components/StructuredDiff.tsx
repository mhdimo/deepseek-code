/**
 * Structured diff rendering (port of Claude Code's
 * components/StructuredDiff/Fallback.tsx + StructuredDiffList.tsx +
 * FileEditToolDiff.tsx DiffFrame).
 *
 * The pipeline: transformLinesToObjects → processAdjacentLines (pairs
 * consecutive removes with following adds for word-level diffing) →
 * numberDiffLines (real line numbers). Each rendered row is TWO Texts —
 * a gutter (line number + sigil) and the content — so fullscreen selection
 * yields clean code, and the content rows double as a copy/selection model
 * (runs + trailing padding fill marked copySkip).
 *
 * Colours follow Fallback.tsx exactly. Its Texts write
 * `color={overrideTheme ? 'text' : undefined}`, and `overrideTheme` is always
 * the current theme name (StructuredDiffFallback reads it with useTheme() and
 * passes it into formatDiff), so nothing in a diff is left to the terminal's
 * default foreground: every row is the theme's `text` token, or `inactive`
 * where the reference sets dimColor — which its ThemedText resolves to a
 * colour rather than to an ANSI faint attribute. Only words that changed
 * within a line get a diff background (diffAddedWord/diffRemovedWord); the
 * line itself keeps diffAdded/diffRemoved (or their Dimmed twins).
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { diffWordsWithSpace, type StructuredPatchHunk } from "diff";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { getTheme, resolveColor, type Theme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";
import type { StyledRun, TextStyle, TextRow } from "../services/selection/lineModel.js";
import { RowText } from "./Markdown.js";

export interface LineObject {
  code: string;
  i: number;
  type: "add" | "remove" | "nochange";
  originalCode: string;
  wordDiff?: boolean;
  matchedLine?: LineObject;
}

export interface DiffLine {
  code: string;
  type: "add" | "remove" | "nochange";
  i: number;
  originalCode: string;
  wordDiff?: boolean;
  matchedLine?: DiffLine;
}

interface StructuredDiffProps {
  patch: StructuredPatchHunk;
  dim?: boolean;
  width: number;
}

/** Past this share of a line pair's characters, the word-level highlight is
 *  dropped and both lines render as plain bands — a mostly-rewritten line
 *  lights up everywhere, which reads as noise rather than as a change. The
 *  reference gates both its renderers on the same number. */
const CHANGE_THRESHOLD = 0.4;

function wrapText(text: string, maxWidth: number): string {
  return wrapAnsi(text, maxWidth, { trim: false, hard: true });
}

/** Wrap runs to the available width, packing physical rows (shared by the
 *  word-diff and syntax-highlighted paths). A piece that follows a break
 *  (width wrap or source newline) always starts a new row. */
function wrapRunsToRows(
  runs: StyledRun[],
  availableWidth: number,
): { runs: StyledRun[]; contentWidth: number }[] {
  const packed: { runs: StyledRun[]; contentWidth: number }[] = [];
  let currentLine: StyledRun[] = [];
  let currentLineWidth = 0;
  for (const run of runs) {
    const pieces = wrapText(run.text, availableWidth).split("\n");
    pieces.forEach((piece, idx) => {
      if (!piece) return;
      if (idx > 0 || currentLineWidth + stringWidth(piece) > availableWidth) {
        if (currentLine.length > 0) {
          packed.push({ runs: currentLine, contentWidth: currentLineWidth });
          currentLine = [];
          currentLineWidth = 0;
        }
      }
      currentLine.push({ text: piece, style: run.style });
      currentLineWidth += stringWidth(piece);
    });
  }
  if (currentLine.length > 0) {
    packed.push({ runs: currentLine, contentWidth: currentLineWidth });
  }
  return packed;
}

/** The frame's dashed border style (stock ink has no "dashed" style). */
export const DASHED_BORDER = {
  top: "╌",
  bottom: "╌",
  left: "╎",
  right: "╎",
  topLeft: " ",
  topRight: " ",
  bottomLeft: " ",
  bottomRight: " ",
} as const;

/** Dashed frame around diff content (Claude Code's DiffFrame). The frame is
 *  always drawn — the loading placeholder sits inside it, as the reference
 *  does (`{placeholder ? <Text dimColor>…</Text> : children}`), and the border
 *  takes the theme's `subtle` token. */
export function DiffFrame({
  children,
  paddingX,
  placeholder,
}: {
  children?: React.ReactNode;
  paddingX?: number;
  placeholder?: boolean;
}): React.ReactElement {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  return (
    <Box flexDirection="column">
      <Box
        borderColor={resolveColor(theme.subtle)}
        borderStyle={DASHED_BORDER}
        flexDirection="column"
        borderLeft={false}
        borderRight={false}
        paddingX={paddingX}
      >
        {placeholder ? <Text dimColor>…</Text> : children}
      </Box>
    </Box>
  );
}

/** One model row of a diff: the non-selectable gutter + content runs. */
export interface DiffRowModel {
  /** Line number + sigil (rendered in its own Text; never copied). */
  gutter: string;
  /** Resolved fg for the gutter: the theme's `text` token, or `inactive` on
   *  unchanged rows (and on dimmed rows) — the reference's
   *  `color={overrideTheme ? 'text' : undefined}` with
   *  `dimColor={dim || type === 'nochange'}`. Never a diff-direction colour:
   *  there is no such token in the reference theme. */
  gutterColor?: string;
  /** Content runs: code (+ word-diff backgrounds) + trailing padding
   *  fill (marked copySkip so copy yields clean code). */
  runs: StyledRun[];
  type: "add" | "remove" | "nochange";
}

export function transformLinesToObjects(lines: string[]): LineObject[] {
  return lines.map((code) => {
    if (code.startsWith("+")) {
      return { code: code.slice(1), i: 0, type: "add", originalCode: code.slice(1) };
    }
    if (code.startsWith("-")) {
      return { code: code.slice(1), i: 0, type: "remove", originalCode: code.slice(1) };
    }
    return { code: code.slice(1), i: 0, type: "nochange", originalCode: code.slice(1) };
  });
}

/** Group adjacent add/remove lines and pair them for word-level diffing. */
export function processAdjacentLines(lineObjects: LineObject[]): LineObject[] {
  const processedLines: LineObject[] = [];
  let i = 0;
  while (i < lineObjects.length) {
    const current = lineObjects[i];
    if (!current) {
      i++;
      continue;
    }

    if (current.type === "remove") {
      const removeLines: LineObject[] = [current];
      let j = i + 1;

      while (j < lineObjects.length && lineObjects[j]?.type === "remove") {
        const line = lineObjects[j];
        if (line) removeLines.push(line);
        j++;
      }

      const addLines: LineObject[] = [];
      while (j < lineObjects.length && lineObjects[j]?.type === "add") {
        const line = lineObjects[j];
        if (line) addLines.push(line);
        j++;
      }

      if (removeLines.length > 0 && addLines.length > 0) {
        const pairCount = Math.min(removeLines.length, addLines.length);

        for (let k = 0; k < pairCount; k++) {
          const removeLine = removeLines[k];
          const addLine = addLines[k];
          if (removeLine && addLine) {
            removeLine.wordDiff = true;
            addLine.wordDiff = true;
            removeLine.matchedLine = addLine;
            addLine.matchedLine = removeLine;
          }
        }

        processedLines.push(...removeLines.filter(Boolean));
        processedLines.push(...addLines.filter(Boolean));
        i = j;
      } else {
        processedLines.push(current);
        i++;
      }
    } else {
      processedLines.push(current);
      i++;
    }
  }
  return processedLines;
}

/** Word-level diff between two text strings (whitespace preserved). */
export function calculateWordDiffs(oldText: string, newText: string) {
  return diffWordsWithSpace(oldText, newText, { ignoreCase: false });
}

export function numberDiffLines(diff: LineObject[], startLine: number): DiffLine[] {
  let i = startLine;
  const result: DiffLine[] = [];
  const queue = [...diff];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const { code, type, originalCode, wordDiff, matchedLine } = current;
    const line = { code, type, i, originalCode, wordDiff, matchedLine };

    switch (type) {
      case "nochange":
        i++;
        result.push(line);
        break;
      case "add":
        i++;
        result.push(line);
        break;
      case "remove": {
        result.push(line);
        let numRemoved = 0;
        while (queue[0]?.type === "remove") {
          i++;
          const next = queue.shift()!;
          result.push({
            code: next.code,
            type: next.type,
            i,
            originalCode: next.originalCode,
            wordDiff: next.wordDiff,
            matchedLine: next.matchedLine as DiffLine | undefined,
          });
          numRemoved++;
        }
        i -= numRemoved;
        break;
      }
    }
  }
  return result;
}

/** Background color token for a line type, resolved for ink. */
function lineBg(type: DiffLine["type"], dim: boolean, theme: Theme): string | undefined {
  if (type === "add") return resolveColor(dim ? theme.diffAddedDimmed : theme.diffAdded);
  if (type === "remove") return resolveColor(dim ? theme.diffRemovedDimmed : theme.diffRemoved);
  return undefined;
}

/** Content fg for a diff row.
 *
 *  The reference writes `color={overrideTheme ? 'text' : undefined}` on every
 *  diff Text, but `overrideTheme` is never absent in the code path we port:
 *  StructuredDiffFallback calls `useTheme()` and hands that theme name to
 *  formatDiff (`formatDiff(patch.lines, patch.oldStart, width, dim, theme)`),
 *  which passes it on to generateWordDiffElements. So the content always
 *  resolves through the theme's `text` token — never the terminal default.
 *
 *  Where the same Text also sets `dimColor`, the reference's ThemedText swaps
 *  the colour out entirely rather than adding an ANSI faint attribute
 *  (`resolvedColor = dimColor ? theme.inactive : resolveColor(color, theme)`,
 *  and dimColor is not forwarded to ink), so a dimmed row is `inactive`. */
function rowTextColor(dim: boolean, theme: Theme): string | undefined {
  return resolveColor(dim ? theme.inactive : theme.text);
}

/** Gutter (line number + sigil) fg. Same tokens as the content, except the
 *  reference dims the gutter on unchanged rows as well:
 *  `dimColor={dim || type === 'nochange'}`. */
function gutterColor(type: DiffLine["type"], dim: boolean, theme: Theme): string | undefined {
  return resolveColor(dim || type === "nochange" ? theme.inactive : theme.text);
}

/** Trailing fill for a row, so the band reaches the full terminal width.
 *
 *  The fill is marked copySkip so a selection copies clean code — except on a
 *  row with no visible content, where the fill is all the row has. RowText
 *  draws a run set whose copy-visible text is empty as a single blank space
 *  with no background, which would drop the band of an added or removed blank
 *  line entirely (the reference keeps both the band and the padding there, its
 *  padding being part of the same Text as the line). */
function fillRun(padding: number, style: TextStyle, hasContent: boolean): StyledRun {
  return { text: " ".repeat(padding), style: hasContent ? { ...style, copySkip: true } : style };
}

/** Word-level diff rows for one item; null when it falls back to standard. */
function buildWordDiffRows(
  item: DiffLine,
  width: number,
  maxWidth: number,
  dim: boolean,
  theme: Theme,
): DiffRowModel[] | null {
  const { type, i, wordDiff, matchedLine, originalCode } = item;
  if (!wordDiff || !matchedLine) return null;
  const removedLineText = type === "remove" ? originalCode : matchedLine.originalCode;
  const addedLineText = type === "remove" ? matchedLine.originalCode : originalCode;
  const wordDiffs = calculateWordDiffs(removedLineText, addedLineText);

  const totalLength = removedLineText.length + addedLineText.length;
  const changedLength = wordDiffs
    .filter((part) => part.added || part.removed)
    .reduce((sum, part) => sum + part.value.length, 0);
  const changeRatio = totalLength > 0 ? changedLength / totalLength : 0;

  if (changeRatio > CHANGE_THRESHOLD || dim) {
    return null; // Falls back to standard rendering for major changes
  }

  const diffPrefix = type === "add" ? "+" : "-";
  const diffPrefixWidth = diffPrefix.length;
  const availableContentWidth = Math.max(1, width - maxWidth - 1 - diffPrefixWidth);
  const partBg = resolveColor(type === "add" ? theme.diffAddedWord : theme.diffRemovedWord);
  const bg = lineBg(type, dim, theme)!;
  const textColor = rowTextColor(dim, theme);

  // Collect the shown parts (changed parts get the word bg, the rest the
  // line bg). The shown parts concatenate exactly to this line's text.
  const parts: { text: string; bg?: string }[] = [];
  wordDiffs.forEach((part) => {
    let shouldShow = false;
    let partBgColor: string | undefined;
    if (type === "add") {
      if (part.added) {
        shouldShow = true;
        partBgColor = partBg;
      } else if (!part.removed) {
        shouldShow = true;
      }
    } else if (type === "remove") {
      if (part.removed) {
        shouldShow = true;
        partBgColor = partBg;
      } else if (!part.added) {
        shouldShow = true;
      }
    }
    if (!shouldShow) return;
    parts.push({ text: part.value, bg: partBgColor });
  });

  // Runs: the shown parts with the line/word backgrounds; changed parts get
  // the word bg, the rest the line bg. The line's fg is the theme text token
  // (the reference hands the nested part Texts no colour of their own, so
  // they inherit the row Text's).
  const runs: StyledRun[] = parts.map((p) => ({
    text: p.text,
    style: { color: textColor, backgroundColor: p.bg ?? bg },
  }));

  const packed = wrapRunsToRows(runs, availableContentWidth);

  // The reference returns whatever this packed to — including nothing at all
  // — without falling back to standard rendering, so a change between two
  // blank lines (whose parts all pack away) draws no row. It only returns
  // null from the ratio/dim gate above.
  const gc = gutterColor(type, dim, theme);
  return packed.map(({ runs: rowRuns, contentWidth }, lineIndex) => {
    const lineNum = lineIndex === 0 ? i : undefined;
    const lineNumStr =
      (lineNum !== undefined ? lineNum.toString().padStart(maxWidth) : " ".repeat(maxWidth)) + " ";
    // Calculate padding to fill the entire terminal width
    const usedWidth = lineNumStr.length + diffPrefixWidth + contentWidth;
    const padding = Math.max(0, width - usedWidth);
    const allRuns = [...rowRuns];
    if (padding > 0) {
      allRuns.push(fillRun(padding, { color: textColor, backgroundColor: bg }, contentWidth > 0));
    }
    return { gutter: lineNumStr + diffPrefix, gutterColor: gc, runs: allRuns, type };
  });
}

/** Standard rendering for lines without word diffing (or as fallback). */
function buildStandardRows(
  item: DiffLine,
  safeWidth: number,
  maxWidth: number,
  dim: boolean,
  theme: Theme,
): DiffRowModel[] {
  const { type, code, i } = item;
  const diffPrefixWidth = 2; // "  " for unchanged, "+ " or "- " for changes
  const availableContentWidth = Math.max(1, safeWidth - maxWidth - 1 - diffPrefixWidth);

  const lineNumStr =
    (i !== undefined ? i.toString().padStart(maxWidth) : " ".repeat(maxWidth)) + " ";
  const sigil = type === "add" ? "+" : type === "remove" ? "-" : " ";
  const bg = lineBg(type, dim, theme);
  // Context lines are NOT dimmed in the reference's content Text (only its
  // gutter is), and a dimmed row is dimmed by colour, not by an ANSI faint.
  const textColor = rowTextColor(dim, theme);

  const wrapped = wrapText(code, availableContentWidth).split("\n");
  const finalLines = wrapped.length === 0 ? [""] : wrapped;
  const contentStyle: TextStyle = { color: textColor };
  if (bg) contentStyle.backgroundColor = bg;
  const rows = finalLines.map((line): { runs: StyledRun[]; contentWidth: number } => ({
    runs: [{ text: line, style: contentStyle }],
    contentWidth: stringWidth(line),
  }));

  const gc = gutterColor(type, dim, theme);
  return rows.map(({ runs, contentWidth }, li) => {
    // A wrapped continuation is still part of the same line, so the sigil
    // column keeps its marker and only the number goes blank.
    const gutter = (li === 0 ? lineNumStr : " ".repeat(maxWidth) + " ") + sigil;
    // Calculate padding to fill the entire terminal width
    const used = stringWidth(gutter) + contentWidth;
    const padding = Math.max(0, safeWidth - used);
    const allRuns = [...runs];
    if (padding > 0) {
      allRuns.push(fillRun(padding, { color: textColor, backgroundColor: bg }, contentWidth > 0));
    }
    return { gutter, gutterColor: gc, runs: allRuns, type };
  });
}

/** Full diff pipeline: lines → numbered, per-row models (gutter + runs). */
export function buildDiffModel(
  lines: string[],
  startingLineNumber: number,
  width: number,
  dim: boolean,
  theme: Theme,
): DiffRowModel[] {
  // Ensure width is at least 1 to prevent rendering issues with very narrow terminals
  const safeWidth = Math.max(1, Math.floor(width));

  const lineObjects = transformLinesToObjects(lines);
  const processedLines = processAdjacentLines(lineObjects);
  const ls = numberDiffLines(processedLines, startingLineNumber);

  // Find max line number width for alignment
  const maxLineNumber = Math.max(...ls.map(({ i }) => i), 0);
  const maxWidth = Math.max(maxLineNumber.toString().length + 1, 0);

  return ls.flatMap((item): DiffRowModel[] => {
    if (item.wordDiff && item.matchedLine) {
      const wordRows = buildWordDiffRows(item, safeWidth, maxWidth, dim, theme);
      if (wordRows !== null) return wordRows;
    }
    return buildStandardRows(item, safeWidth, maxWidth, dim, theme);
  });
}

/** Render a diff row's model: gutter Text (never selected) + content RowText. */
export function DiffRow({
  row,
  dim,
  theme,
  contentWidth,
  selCols,
}: {
  row: DiffRowModel;
  dim: boolean;
  theme: Theme;
  /** Width of the content area (runs), for selection column math. */
  contentWidth: number;
  /** Selection columns (content-relative), null when not selectable. */
  selCols?: [number, number] | null;
}): React.ReactElement {
  const bg = lineBg(row.type, dim, theme);
  const textRow: TextRow = { runs: row.runs, softWrapped: false };
  return (
    <Box flexDirection="row">
      {/* The gutter's dim state rides in its colour (theme.inactive), the way
          the reference's ThemedText resolves dimColor — no ANSI faint on top
          of it. The content Text next to it carries the same background, so
          the band is continuous. */}
      <Text backgroundColor={bg} color={row.gutterColor}>
        {row.gutter}
      </Text>
      <RowText row={textRow} selCols={selCols ?? null} rowWidth={contentWidth} />
    </Box>
  );
}

export function StructuredDiff({ patch, dim = false, width }: StructuredDiffProps) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const rows = useMemo(
    () => buildDiffModel(patch.lines, patch.oldStart, width, dim, theme),
    [patch.lines, patch.oldStart, width, dim, theme],
  );
  // All gutters share one width (line digits + space + sigil); the content
  // area is the remainder (selection column math is content-relative).
  const gutterWidth = rows.length > 0 ? stringWidth(rows[0]!.gutter) : 0;
  const contentWidth = Math.max(1, Math.floor(width) - gutterWidth);
  return (
    <Box flexDirection="column" flexGrow={1}>
      {rows.map((row, i) => (
        <Box key={i}>
          <DiffRow row={row} dim={dim} theme={theme} contentWidth={contentWidth} />
        </Box>
      ))}
    </Box>
  );
}

/** Intersperse hunks with "..." separators (Claude Code's StructuredDiffList).
 *
 *  Every hunk it is handed is rendered: the reference has no truncation row,
 *  and its only marker is the dim "..." between two hunks. A caller that wants
 *  a diff to stop at some height has to cut the text it passes in, not ask for
 *  fewer rows here — a silent row cap would drop content the reference draws. */
export function StructuredDiffList({
  hunks,
  dim = false,
  width,
}: {
  hunks: StructuredPatchHunk[];
  dim?: boolean;
  width: number;
}): React.ReactElement | null {
  if (hunks.length === 0) return null;

  return (
    <Box flexDirection="column">
      {hunks.map((h, i) => (
        <React.Fragment key={h.newStart}>
          {i > 0 && (
            <Box flexDirection="row">
              <Text dimColor>...</Text>
            </Box>
          )}
          <StructuredDiff patch={h} dim={dim} width={width} />
        </React.Fragment>
      ))}
    </Box>
  );
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse unified-diff text (with @@ headers) into hunks. Lines that aren't
 *  +/-/space or headers (file markers, prose) are skipped. */
export function parseDiffTextToHunks(diffText: string): StructuredPatchHunk[] {
  const allLines = diffText.split("\n");
  const hunks: StructuredPatchHunk[] = [];
  let current: StructuredPatchHunk | null = null;
  for (const line of allLines) {
    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldLines: Number(m[2] ?? 1),
        newStart: Number(m[3]),
        newLines: Number(m[4] ?? 1),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      if (!current) {
        current = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [] };
        hunks.push(current);
      }
      current.lines.push(line);
    }
  }
  return hunks.filter((h) => h.lines.length > 0);
}

/** Single-hunk view (legacy callers); first hunk of the parsed text. */
export function parseDiffTextToHunk(diffText: string): StructuredPatchHunk | null {
  return parseDiffTextToHunks(diffText)[0] ?? null;
}
