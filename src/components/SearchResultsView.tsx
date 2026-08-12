// SearchResultsView — /search results overlay. Ported from
// claude-code-main's GlobalSearchDialog result list: rows carry a dim
// location prefix (here `label · msg N` instead of `file:line`) plus the
// matched text with inverse highlighting (reference highlightMatch()).
//
// Highlight spans are derived from transcriptSearch's HighlightRange: the
// first span is placed at the range-driven snippetHighlightStart with the
// first range's length; any further occurrences of the query inside the
// snippet are appended (non-overlapping, case-insensitive), mirroring the
// reference's every-occurrence highlighting.
//
// Keys: ↑↓ move, n/N jump to next/previous match (wrapping, via
// transcriptSearch.nextMatchIndex), Enter jumps the transcript to the
// match's message (optional onJump) and closes, Esc closes.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme, resolveColor, type Theme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";
import { nextMatchIndex, type SearchMatch } from "../utils/transcriptSearch.js";

export interface SearchResultsViewProps {
  /** The search query as typed (shown in the header, drives extra spans). */
  query: string;
  /** Ranked matches from searchMessages(). */
  matches: SearchMatch[];
  /** Total matches (may exceed matches.length if the list was sliced). */
  totalMatches?: number;
  /** Esc / done. The parent unmounts the view. */
  onClose: () => void;
  /** Enter on a match: jump the transcript to that message. Optional. */
  onJump?: (messageIndex: number) => void;
}

/** Fallback palette used when a theme token is missing (see shared rules). */
const FALLBACK_PALETTE: Partial<Record<keyof Theme, string>> = {
  suggestion: "rgb(177, 185, 249)",
  inactive: "rgb(153, 153, 153)",
  subtle: "rgb(80, 80, 80)",
  promptBorder: "rgb(136, 136, 136)",
};

/**
 * Render the match's snippet with inverse-highlighted spans. The first span
 * is range-driven (snippetHighlightStart + highlights[0] length); remaining
 * occurrences of the query inside the snippet are found with a
 * non-overlapping case-insensitive scan, matching the reference's
 * highlightMatch() behavior.
 */
function renderHighlightedSnippet(
  match: SearchMatch,
  query: string,
  maxWidth: number,
): React.ReactNode {
  const { snippet, snippetHighlightStart, highlights } = match;
  const text = snippet.length > maxWidth ? snippet.slice(0, maxWidth - 1) + "…" : snippet;

  // 1. The range-derived first span.
  const spans: Array<{ start: number; end: number }> = [];
  const first = highlights[0];
  if (first) {
    const firstLen = first.end - first.start;
    if (
      snippetHighlightStart >= 0 &&
      snippetHighlightStart + firstLen <= text.length
    ) {
      spans.push({ start: snippetHighlightStart, end: snippetHighlightStart + firstLen });
    }
  }
  // 2. Further occurrences of the query within the snippet (non-overlapping).
  const needle = query.trim().toLowerCase();
  if (needle) {
    const lower = text.toLowerCase();
    let from = spans.length > 0 ? spans[0]!.end : 0;
    let guard = 0;
    while (guard < 100) {
      const idx = lower.indexOf(needle, from);
      if (idx < 0) break;
      spans.push({ start: idx, end: idx + needle.length });
      from = idx + needle.length;
      guard++;
    }
  }

  if (spans.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let offset = 0;
  for (const s of spans) {
    if (s.start > offset) parts.push(text.slice(offset, s.start));
    parts.push(
      <Text key={`${s.start}-${s.end}`} inverse>
        {text.slice(s.start, s.end)}
      </Text>,
    );
    offset = s.end;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return <>{parts}</>;
}

export default function SearchResultsView({
  query,
  matches,
  totalMatches,
  onClose,
  onJump,
}: SearchResultsViewProps): React.ReactElement {
  const [selected, setSelected] = useState(0);

  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const token = (k: keyof Theme): string =>
    resolveColor(theme[k] ?? FALLBACK_PALETTE[k] ?? "rgb(255, 255, 255)");

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      const m = matches[selected];
      if (m) onJump?.(m.messageIndex);
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((i) => Math.min(matches.length - 1, i + 1)); // next match in list
      return;
    }
    if (key.downArrow) {
      setSelected((i) => Math.max(0, i - 1)); // previous match in list
      return;
    }
    if (key.shift && input === "N") {
      setSelected((i) => nextMatchIndex(matches.length, i, -1));
      return;
    }
    if (input === "n" || input === "N") {
      setSelected((i) => nextMatchIndex(matches.length, i, 1));
    }
  });

  const cols = process.stdout.columns || 80;
  const maxW = cols - 8;
  const total = totalMatches ?? matches.length;
  const matchLabel = `${total} match${total === 1 ? "" : "es"}`;

  return (
    <Box flexDirection="column" paddingX={2} marginY={0}>
      {/* Header */}
      <Box flexDirection="row">
        <Text bold color={token("suggestion")}>
          {"Search Results: "}
        </Text>
        <Text color={token("promptBorder")}>{query}</Text>
        <Text dimColor>{`  (${matchLabel})`}</Text>
      </Box>

      {/* Result rows */}
      <Box flexDirection="column" marginTop={1}>
        {matches.length === 0 ? (
          <Text dimColor>{`  No matches for "${query}".`}</Text>
        ) : (
          matches.map((m, i) => {
            const active = i === selected;
            return (
              <Box key={`${m.messageIndex}-${m.field}-${m.blockIndex}`} flexDirection="row">
                <Text color={active ? token("suggestion") : undefined}>
                  {active ? "▸ " : "  "}
                  <Text dimColor>{`${m.label} · msg ${m.messageIndex + 1}`}</Text>
                  {"  "}
                  {renderHighlightedSnippet(m, query, maxW - 4)}
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      <Text dimColor>  ↑↓ navigate · n/N next match · Enter jump · Esc close</Text>
    </Box>
  );
}
