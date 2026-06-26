// HistorySearch — Ctrl+R overlay for fuzzy search across persisted prompt
// history. Full-screen (renders in place of the input), own key handling.
// Enter inserts the selected entry into the input; Esc closes.

import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../utils/theme.js";
import { fuzzyFilter } from "../utils/fuzzy.js";

interface HistorySearchProps {
  entries: string[]; // most-recent-first is handled here
  onPick: (entry: string) => void;
  onClose: () => void;
}

export default function HistorySearch({ entries, onPick, onClose }: HistorySearchProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

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
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }
    if (key.ctrl && input === "u") {
      setQuery("");
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setQuery((q) => q + input);
    }
  });

  const cols = process.stdout.columns || 80;
  const rule = "─".repeat(Math.max(10, cols - 4));
  const maxW = cols - 8;

  return (
    <Box flexDirection="column" paddingX={2} marginY={0}>
      <Text color="gray">{rule}</Text>
      <Box flexDirection="row">
        <Text color={theme.assistant} bold>
          {"⌕ History "}
        </Text>
        <Text dimColor>{query ? "filter: " : "(type to search · most recent first)"}</Text>
        <Text color="cyan" bold>
          {query}
        </Text>
        <Text color={theme.promptBorder}>{"█"}</Text>
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {results.length === 0 ? (
          <Text dimColor>  {query ? "No matches." : "No history yet."}</Text>
        ) : (
          results.map((r, i) => {
            const active = i === selected;
            const text = r.item.length > maxW ? r.item.slice(0, maxW - 1) + "…" : r.item;
            return (
              <Box key={`${i}-${r.item}`} flexDirection="row">
                <Text color="cyan">{active ? "▶ " : "  "}</Text>
                <Text color={active ? theme.assistant : undefined} bold={active} wrap="wrap">
                  {text}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
      <Text color="gray">{rule}</Text>
      <Text dimColor>  ↑↓ navigate · Enter insert · Esc close</Text>
    </Box>
  );
}
