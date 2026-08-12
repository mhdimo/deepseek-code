// ExportView — modal-ish export UI for /export. Ported from
// claude-code-main's ExportDialog: a titled dialog with an option list
// (format choice), plus an include-thinking toggle and a written-path
// confirmation phase after the parent's write completes.
//
// Differences from the reference: the reference writes the file itself and
// offers clipboard/file with a filename sub-screen; here the parent owns the
// write (it auto-generates the filename and already has writeToFile), so
// ExportView delegates via onExport() and only renders phases:
//   choose (format + toggle) → working → result (✓ path / ✗ error).

import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme, resolveColor, type Theme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";
import type { ExportFormat } from "../utils/exportConversation.js";

export interface ExportResult {
  success: boolean;
  message: string;
}

export interface ExportViewProps {
  /** Format preselected when the view opens. Defaults to "markdown". */
  defaultFormat?: ExportFormat;
  /** Initial state of the include-thinking toggle. Defaults to true. */
  includeThinking?: boolean;
  /** Esc in any phase (and Enter after the result is shown). Parent unmounts. */
  onCancel: () => void;
  /**
   * Perform the export. The returned (or resolved) result is shown as the
   * written-path confirmation — the message usually carries the path and
   * byte count (see utils/exportConversation.ts writeToFile).
   */
  onExport: (format: ExportFormat, includeThinking: boolean) => ExportResult | Promise<ExportResult>;
}

/** Fallback palette used when a theme token is missing (see shared rules). */
const FALLBACK_PALETTE: Partial<Record<keyof Theme, string>> = {
  permission: "rgb(177, 185, 249)",
  suggestion: "rgb(177, 185, 249)",
  inactive: "rgb(153, 153, 153)",
  subtle: "rgb(80, 80, 80)",
  success: "rgb(78, 186, 101)",
  error: "rgb(255, 107, 128)",
};

type Phase = "choose" | "working" | "result";

const FORMAT_OPTIONS: Array<{ format: ExportFormat; label: string; detail: string }> = [
  { format: "markdown", label: "Save as Markdown", detail: "(.md) · readable transcript" },
  { format: "json", label: "Save as JSON", detail: "(.json) · structured data" },
];

/** Rows: the two format options, then the include-thinking toggle. */
const ROW_COUNT = FORMAT_OPTIONS.length + 1;
const TOGGLE_ROW = FORMAT_OPTIONS.length;

export default function ExportView({
  defaultFormat = "markdown",
  includeThinking: initialIncludeThinking = true,
  onCancel,
  onExport,
}: ExportViewProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("choose");
  const [selected, setSelected] = useState(0);
  const [format, setFormat] = useState<ExportFormat>(defaultFormat);
  const [includeThinking, setIncludeThinking] = useState(initialIncludeThinking);
  const [result, setResult] = useState<ExportResult | null>(null);

  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const token = (k: keyof Theme): string =>
    resolveColor(theme[k] ?? FALLBACK_PALETTE[k] ?? "rgb(255, 255, 255)");

  const runExport = useCallback(
    (fmt: ExportFormat, thinking: boolean) => {
      setPhase("working");
      void Promise.resolve(onExport(fmt, thinking))
        .then((res) => {
          setResult(res);
          setPhase("result");
        })
        .catch((err: unknown) => {
          setResult({
            success: false,
            message: `Export failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          });
          setPhase("result");
        });
    },
    [onExport],
  );

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (phase === "working") return; // ignore input while exporting
    if (phase === "result") {
      if (key.return) onCancel();
      return;
    }
    // choose phase
    if (key.return) {
      if (selected === TOGGLE_ROW) {
        setIncludeThinking((t) => !t);
      } else {
        const opt = FORMAT_OPTIONS[selected];
        if (opt) {
          setFormat(opt.format);
          runExport(opt.format, includeThinking);
        }
      }
      return;
    }
    if (key.upArrow) {
      setSelected((s) => Math.min(ROW_COUNT - 1, s + 1)); // previous option
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.max(0, s - 1)); // next option
      return;
    }
    // Space / Tab / "t" toggle include-thinking from anywhere in the list.
    if (key.tab || input === " " || input === "t" || input === "T") {
      setIncludeThinking((t) => !t);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={token("permission")}
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Text bold color={token("permission")}>
        Export Conversation
      </Text>
      <Text dimColor>Select export method:</Text>

      {phase === "choose" && (
        <>
          {FORMAT_OPTIONS.map((opt, i) => {
            const active = i === selected;
            return (
              <Box key={opt.format} flexDirection="row" marginTop={0}>
                <Text color={active ? token("suggestion") : undefined}>
                  {active ? "▸ " : "  "}
                  <Text bold={active}>{opt.label}</Text>
                  <Text dimColor>{"  " + opt.detail}</Text>
                </Text>
              </Box>
            );
          })}
          {/* Include-thinking toggle row */}
          <Box flexDirection="row">
            <Text color={TOGGLE_ROW === selected ? token("suggestion") : undefined}>
              {TOGGLE_ROW === selected ? "▸ " : "  "}
              <Text inverse={includeThinking} color={includeThinking ? token("success") : token("inactive")}>
                {includeThinking ? " [x]" : " [ ]"}
              </Text>
              <Text bold={TOGGLE_ROW === selected}> Include thinking/reasoning</Text>
              <Text dimColor>{"  (model reasoning text)"}</Text>
            </Text>
          </Box>
        </>
      )}

      {phase === "working" && <Text dimColor>  Exporting…</Text>}

      {phase === "result" && result && (
        <>
          <Text color={result.success ? token("success") : token("error")}>
            {result.success ? "✓ " : "✗ "}
            {result.message}
          </Text>
          <Text dimColor>  Enter or Esc to close</Text>
        </>
      )}

      <Text dimColor>  ↑↓ select · Enter export · Space toggle thinking · Esc cancel</Text>
    </Box>
  );
}
