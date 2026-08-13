














import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme, resolveColor, type Theme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";
import { nextMatchIndex, type SearchMatch } from "../utils/transcriptSearch.js";

export interface SearchResultsViewProps {
  
  query: string;
  
  matches: SearchMatch[];
  
  totalMatches?: number;
  
  onClose: () => void;
  
  onJump?: (messageIndex: number) => void;
}


const FALLBACK_PALETTE: Partial<Record<keyof Theme, string>> = {
  suggestion: "rgb(177, 185, 249)",
  inactive: "rgb(153, 153, 153)",
  subtle: "rgb(80, 80, 80)",
  promptBorder: "rgb(136, 136, 136)",
};


function renderHighlightedSnippet(
  match: SearchMatch,
  query: string,
  maxWidth: number,
): React.ReactNode {
  const { snippet, snippetHighlightStart, highlights } = match;
  const text = snippet.length > maxWidth ? snippet.slice(0, maxWidth - 1) + "…" : snippet;

  
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
      setSelected((i) => Math.min(matches.length - 1, i + 1)); 
      return;
    }
    if (key.downArrow) {
      setSelected((i) => Math.max(0, i - 1)); 
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
      {}
      <Box flexDirection="row">
        <Text bold color={token("suggestion")}>
          {"Search Results: "}
        </Text>
        <Text color={token("promptBorder")}>{query}</Text>
        <Text dimColor>{`  (${matchLabel})`}</Text>
      </Box>

      {}
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
