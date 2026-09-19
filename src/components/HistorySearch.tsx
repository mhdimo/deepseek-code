import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import stringWidth from "string-width";
import { fuzzyFilter } from "../utils/fuzzy.js";
import { getTheme, resolveColor, type Theme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";
import { stripMouseSequences } from "./useMouseWheelScroll.js";

/** A history entry. Bare strings are the legacy shape — `history.json` has
 *  always been a string array; the object form carries the timestamp the
 *  reference's relative-age column renders. */
export type HistorySearchEntry = string | { entry: string; timestamp?: number };

interface HistorySearchProps {
  entries: readonly HistorySearchEntry[];
  onPick: (entry: string) => void;
  onClose: () => void;
}

const FALLBACK_PALETTE: Partial<Record<keyof Theme, string>> = {
  suggestion: "rgb(177, 185, 249)",
  inactive: "rgb(153, 153, 153)",
  subtle: "rgb(80, 80, 80)",
  promptBorder: "rgb(136, 136, 136)",
  claude: "rgb(95, 217, 226)",
};

const PREVIEW_ROWS = 6;
const PREVIEW_BOX_HEIGHT = PREVIEW_ROWS + 2;
/** Reference gutter for a row's relative age (`AGE_WIDTH` in the dialog). */
const AGE_WIDTH = 8;
/** Reference `compact` breakpoint — the hint line shortens below this width. */
const COMPACT_COLUMNS = 120;

export function entryText(entry: HistorySearchEntry): string {
  return typeof entry === "string" ? entry : entry.entry;
}

export function entryTimestamp(entry: HistorySearchEntry): number | undefined {
  return typeof entry === "string" ? undefined : entry.timestamp;
}

/**
 * Reference `formatRelativeTimeAgo`: `Intl.RelativeTimeFormat` in narrow style
 * with `numeric: 'always'`, so a prompt typed seconds ago reads "0s ago".
 * (SessionPicker's copy of this helper says "just now" under a minute; the
 * history dialog's column follows upstream here.)
 */
export function formatAge(timestamp: number, now: number = Date.now()): string {
  const diffSeconds = Math.trunc((timestamp - now) / 1000);
  const intervals: Array<[number, string]> = [
    [31536000, "y"],
    [2592000, "mo"],
    [604800, "w"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  for (const [seconds, unit] of intervals) {
    if (Math.abs(diffSeconds) >= seconds) {
      const value = Math.trunc(diffSeconds / seconds);
      return diffSeconds < 0 ? `${Math.abs(value)}${unit} ago` : `in ${value}${unit}`;
    }
  }
  return diffSeconds <= 0 ? "0s ago" : "in 0s";
}

/** Age cell, right-padded to AGE_WIDTH so every prompt starts in one column. */
export function ageCell(timestamp: number | undefined, now: number = Date.now()): string {
  const age = timestamp === undefined ? "" : formatAge(timestamp, now);
  return age + " ".repeat(Math.max(0, AGE_WIDTH - stringWidth(age)));
}

/** The reference lists one row per entry: a prompt's first line, not all of it. */
export function firstLineOf(display: string): string {
  const nl = display.indexOf("\n");
  return nl === -1 ? display : display.slice(0, nl);
}

/** Reference `truncateToWidth`: display-width aware, "…" when it does not fit. */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 1) return "…";
  let width = 0;
  let result = "";
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (width + charWidth > maxWidth - 1) break;
    result += char;
    width += charWidth;
  }
  return result + "…";
}

/** List column width: the pane's padding, the pointer and its gap. */
function listWidthFor(columns: number, previewOnRight: boolean): number {
  return previewOnRight ? Math.floor((columns - 6) * 0.5) : columns - 6;
}

/** Width the prompt text may use — the reference's `rowWidth`. */
export function rowWidthFor(columns: number, previewOnRight: boolean): number {
  return Math.max(20, listWidthFor(columns, previewOnRight) - AGE_WIDTH - 1);
}

/** Width the wrapped preview may use — the reference's `previewWidth`. */
export function previewWidthFor(columns: number, previewOnRight: boolean): number {
  return previewOnRight
    ? Math.max(20, columns - listWidthFor(columns, previewOnRight) - 12)
    : Math.max(20, columns - 10);
}

/** One row, split the way the reference's `renderItem` splits it. */
export function historyRow(
  entry: HistorySearchEntry,
  options: { rowWidth: number; now?: number },
): { age: string; text: string } {
  return {
    age: ageCell(entryTimestamp(entry), options.now),
    text: truncateToWidth(firstLineOf(entryText(entry)), options.rowWidth),
  };
}

/** Reference hint line: "↑/↓ to nav · Enter to use · Esc to cancel". */
export function footerHint(columns: number): string {
  return `↑/↓ to ${columns < COMPACT_COLUMNS ? "nav" : "navigate"} · Enter to use · Esc to cancel`;
}

/** Reference empty-state copy. Its "Loading…" cannot happen here — the picker
 *  is handed an already-loaded history snapshot. */
export function emptyMessage(query: string): string {
  return query ? "No matching prompts" : "No history yet";
}

function previewLines(entry: string, width: number): { lines: string[]; more: number } {
  const all: string[] = [];
  for (const raw of entry.split("\n")) {
    if (!raw.trim()) continue;
    let line = raw;
    while (line.length > width) {
      all.push(line.slice(0, width));
      line = line.slice(width);
    }
    if (line) all.push(line);
  }
  const overflow = all.length > PREVIEW_ROWS;
  const shown = all.slice(0, overflow ? PREVIEW_ROWS - 1 : PREVIEW_ROWS);
  return { lines: shown, more: all.length - shown.length };
}

export default function HistorySearch({ entries, onPick, onClose }: HistorySearchProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [selected, setSelected] = useState(0);

  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const token = (k: keyof Theme): string =>
    resolveColor(theme[k] ?? FALLBACK_PALETTE[k] ?? "rgb(255, 255, 255)");


  const reversed = useMemo(() => [...entries].reverse(), [entries]);
  const results = useMemo(
    () => fuzzyFilter(query, reversed, entryText, 14),
    [query, reversed],
  );
  useEffect(() => {
    setSelected(0);
  }, [query]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      const pick = results[selected]?.item ?? results[0]?.item;
      if (pick) onPick(entryText(pick));
      else onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((i) => Math.min(results.length - 1, i + 1));
      return;
    }
    if (key.downArrow) {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.leftArrow) {
      setCursorOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorOffset((o) => Math.min(query.length, o + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, Math.max(0, cursorOffset - 1)) + q.slice(cursorOffset));
      setCursorOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.ctrl && input === "u") {
      setQuery("");
      setCursorOffset(0);
      return;
    }
    // Mouse reports arrive with an empty key name; strip them so a click while
    // the search box has focus does not become part of the query.
    const typed = stripMouseSequences(input);
    if (typed && !key.ctrl && !key.meta && !key.tab) {
      setQuery((q) => q.slice(0, cursorOffset) + typed + q.slice(cursorOffset));
      setCursorOffset((o) => o + typed.length);
    }
  });

  const columns = process.stdout.columns || 80;
  const previewOnRight = columns >= 100;
  const rowWidth = rowWidthFor(columns, previewOnRight);
  const selectedEntry = results[selected]?.item;
  const preview = selectedEntry
    ? previewLines(entryText(selectedEntry), previewWidthFor(columns, previewOnRight))
    : null;

  // Reference row anatomy: ListItem's pointer, then the dim age column, then the
  // prompt's first line, truncated to the row width.
  const list = (
    <Box flexDirection="column">
      {results.length === 0 ? (
        <Text dimColor>{emptyMessage(query)}</Text>
      ) : (
        results.map((r, i) => {
          const active = i === selected;
          const row = historyRow(r.item, { rowWidth });
          return (
            <Box key={`${i}-${entryText(r.item)}`} flexDirection="row">
              <Text color={active ? token("suggestion") : undefined}>{active ? "❯ " : "  "}</Text>
              <Text dimColor>{row.age}</Text>
              <Text color={active ? token("suggestion") : undefined}> {row.text}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );

  const previewBox = preview ? (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor
      paddingX={1}
      height={PREVIEW_BOX_HEIGHT}
    >
      {preview.lines.map((row, i) => (
        <Text key={i} dimColor>
          {row}
        </Text>
      ))}
      {preview.more > 0 && <Text dimColor>{`… +${preview.more} more lines`}</Text>}
    </Box>
  ) : null;

  return (
    <Box flexDirection="column" gap={1} paddingX={2} marginY={0}>
      <Text bold color={token("permission")}>
        Search prompts
      </Text>

      <Box flexShrink={0} borderStyle="round" borderColor={token("suggestion")} paddingX={1}>
        <Text color={token("inactive")}>
          {"⌕ "}
          {query ? (
            <>
              <Text>{query.slice(0, cursorOffset)}</Text>
              <Text inverse>{cursorOffset < query.length ? query[cursorOffset] : " "}</Text>
              {cursorOffset < query.length && <Text>{query.slice(cursorOffset + 1)}</Text>}
            </>
          ) : (
            <>
              <Text inverse>{"F"}</Text>
              <Text dimColor>{"ilter history…"}</Text>
            </>
          )}
        </Text>
      </Box>

      {/* Wide terminals put the preview beside the list, as the reference does. */}
      {previewOnRight ? (
        <Box flexDirection="row" gap={2}>
          <Box flexDirection="column" flexShrink={0}>
            {list}
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {previewBox}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {list}
          {previewBox}
        </Box>
      )}

      <Text dimColor>{footerHint(columns)}</Text>
    </Box>
  );
}
