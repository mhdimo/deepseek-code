// HistorySearch — Ctrl+R overlay for fuzzy search across persisted prompt
// history. Full-screen (renders in place of the input), own key handling.
// Enter inserts the selected entry into the input; Esc closes.
//
// Ported from claude-code-main's HistorySearchDialog + SearchBox:
//   • SearchBox-style input row — round border, ⌕ prefix, placeholder with
//     inverse first char, block cursor that tracks cursorOffset.
//   • Result rows with the focused row in the `suggestion` theme color
//     (reference: `color={isFocused ? 'suggestion' : undefined}`).
//   • A bottom preview pane of the selected entry (reference
//     renderPreview): rounded dim border, up to 6 rows, "+N more lines"
//     overflow marker.
// Entries here are plain strings (no timestamps), so the reference's
// relative-time "age" column is omitted.

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { fuzzyFilter } from "../utils/fuzzy.js";
import { getTheme, resolveColor, type Theme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";

interface HistorySearchProps {
  entries: string[]; // most-recent-first is handled here
  onPick: (entry: string) => void;
  onClose: () => void;
}

/** Fallback palette used when a theme token is missing (see shared rules). */
const FALLBACK_PALETTE: Partial<Record<keyof Theme, string>> = {
  suggestion: "rgb(177, 185, 249)",
  inactive: "rgb(153, 153, 153)",
  subtle: "rgb(80, 80, 80)",
  promptBorder: "rgb(136, 136, 136)",
  claude: "rgb(95, 217, 226)",
};

const PREVIEW_ROWS = 6;

/**
 * Wrap an entry for the preview pane: hard-wrap long lines, drop blank
 * lines, cap at PREVIEW_ROWS. Returns the shown lines plus how many more
 * there were (reference: "… +N more lines").
 */
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

  // Most recent first.
  const reversed = useMemo(() => [...entries].reverse(), [entries]);
  const results = useMemo(
    () => fuzzyFilter(query, reversed, (s) => s, 14),
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
      if (pick) onPick(pick);
      else onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((i) => Math.min(results.length - 1, i + 1)); // older
      return;
    }
    if (key.downArrow) {
      setSelected((i) => Math.max(0, i - 1)); // newer
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
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setQuery((q) => q.slice(0, cursorOffset) + input + q.slice(cursorOffset));
      setCursorOffset((o) => o + input.length);
    }
  });

  const cols = process.stdout.columns || 80;
  const maxW = cols - 8;
  const selectedEntry = results[selected]?.item;
  const preview = selectedEntry ? previewLines(selectedEntry, maxW - 4) : null;

  return (
    <Box flexDirection="column" paddingX={2} marginY={0}>
      {/* SearchBox-style input row */}
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

      {/* Result rows */}
      <Box flexDirection="column" marginTop={1}>
        {results.length === 0 ? (
          <Text dimColor>  {query ? "No matches." : "No history yet."}</Text>
        ) : (
          results.map((r, i) => {
            const active = i === selected;
            const text = r.item.length > maxW ? r.item.slice(0, maxW - 1) + "…" : r.item;
            return (
              <Box key={`${i}-${r.item}`} flexDirection="row">
                <Text color={active ? token("suggestion") : undefined}>{active ? "▸ " : "  "}</Text>
                <Text color={active ? token("suggestion") : undefined} wrap="wrap">
                  {text}
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      {/* Preview of the selected entry */}
      {preview && (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
          {preview.lines.map((row, i) => (
            <Text key={i} dimColor>
              {row}
            </Text>
          ))}
          {preview.more > 0 && <Text dimColor>{`… +${preview.more} more lines`}</Text>}
        </Box>
      )}

      <Text dimColor>  ↑↓ navigate · Enter insert · Esc close</Text>
    </Box>
  );
}
