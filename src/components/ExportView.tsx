import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme, resolveColor, type Theme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";
import { Dialog } from "../ui/design-system/Dialog.js";
import type { ExportFormat } from "../utils/exportConversation.js";
import { stripMouseSequences } from "./useMouseWheelScroll.js";

export interface ExportResult {
  success: boolean;
  message: string;
}

export interface ExportViewProps {

  defaultFormat?: ExportFormat;

  includeThinking?: boolean;

  onCancel: () => void;

  onExport: (format: ExportFormat, includeThinking: boolean) => ExportResult | Promise<ExportResult>;

  onCopy?: (format: ExportFormat, includeThinking: boolean) => ExportResult | Promise<ExportResult>;

  onSaveToFile?: (filename: string, format: ExportFormat, includeThinking: boolean) => ExportResult | Promise<ExportResult>;

  onDone?: (result: ExportResult) => void;
}


const FALLBACK_PALETTE: Partial<Record<keyof Theme, string>> = {
  permission: "rgb(177, 185, 249)",
  suggestion: "rgb(177, 185, 249)",
  inactive: "rgb(153, 153, 153)",
  subtle: "rgb(80, 80, 80)",
  success: "rgb(78, 186, 101)",
  error: "rgb(255, 107, 128)",
};

type Phase = "choose" | "working" | "result";
type Screen = "options" | "filename";


const EXPORT_OPTIONS = [
  {
    id: "clipboard",
    label: "Copy to clipboard",
    description: "Copy the conversation to your system clipboard",
  },
  {
    id: "file",
    label: "Save to file",
    description: "Save the conversation to a file in the current directory",
  },
] as const;

const ROW_COUNT = EXPORT_OPTIONS.length + 1;
const TOGGLE_ROW = EXPORT_OPTIONS.length;

/** Default name offered in the filename step — same shape the timestamped
 *  auto-export uses, with the extension carrying the format. */
export function defaultExportFilename(format: ExportFormat = "markdown"): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `deepseek-code-export-${ts}.${format === "json" ? "json" : "md"}`;
}

/**
 * Resolve the typed filename: keep an explicit extension (its `.json` decides
 * the format), otherwise append the default one. Mirrors the reference's
 * filename coercion in ExportDialog.handleFilenameSubmit.
 */
export function resolveExportFile(
  name: string,
  fallbackFormat: ExportFormat = "markdown",
): { filename: string; format: ExportFormat } {
  const trimmed = name.trim();
  const hasExtension = /\.[^./\\\s]+$/.test(trimmed);
  const filename =
    trimmed === "" || hasExtension
      ? trimmed
      : `${trimmed}.${fallbackFormat === "json" ? "json" : "md"}`;
  const format: ExportFormat = /\.json$/i.test(filename) ? "json" : "markdown";
  return { filename, format };
}

export default function ExportView({
  defaultFormat = "markdown",
  includeThinking: initialIncludeThinking = true,
  onCancel,
  onExport,
  onCopy,
  onSaveToFile,
  onDone,
}: ExportViewProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("choose");
  const [screen, setScreen] = useState<Screen>("options");
  const [selected, setSelected] = useState(0);
  const [format, setFormat] = useState<ExportFormat>(defaultFormat);
  const [includeThinking, setIncludeThinking] = useState(initialIncludeThinking);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [filename, setFilename] = useState(() => defaultExportFilename(defaultFormat));
  const [cursor, setCursor] = useState(() => defaultExportFilename(defaultFormat).length);

  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const token = (k: keyof Theme): string =>
    resolveColor(theme[k] ?? FALLBACK_PALETTE[k] ?? "rgb(255, 255, 255)");

  const finish = useCallback(
    (res: ExportResult) => {
      setPhase("choose");
      setScreen("options");
      // The reference hands the outcome to the host, which closes the dialog
      // and shows the text in the transcript. Hosts that pass no onDone keep
      // the older in-dialog result line so the outcome is never lost.
      if (onDone) {
        onDone(res);
      } else {
        setResult(res);
        setPhase("result");
      }
    },
    [onDone],
  );

  const run = useCallback(
    (work: ExportResult | Promise<ExportResult>) => {
      setPhase("working");
      void Promise.resolve(work)
        .then(finish)
        .catch((err: unknown) => {
          finish({
            success: false,
            message: `Export failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          });
        });
    },
    [finish],
  );

  const runCopy = useCallback(() => {
    if (!onCopy) {
      finish({
        success: false,
        message: "Clipboard export is unavailable — use Save to file instead.",
      });
      return;
    }
    run(onCopy(format, includeThinking));
  }, [onCopy, format, includeThinking, finish, run]);

  const runFile = useCallback(
    (name?: string) => {
      if (name !== undefined && onSaveToFile) {
        const resolved = resolveExportFile(name, format);
        setFormat(resolved.format);
        run(onSaveToFile(resolved.filename, resolved.format, includeThinking));
        return;
      }
      run(onExport(format, includeThinking));
    },
    [onSaveToFile, onExport, format, includeThinking, run],
  );

  useInput((input, key) => {
    if (phase === "working") return;

    if (screen === "filename") {
      if (key.escape) {
        setScreen("options");
        return;
      }
      if (key.return) {
        if (filename.trim().length === 0) return;
        runFile(filename);
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(filename.length, c + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setFilename((prev) => prev.slice(0, Math.max(0, cursor - 1)) + prev.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.ctrl) return;
      // A click while the filename field has focus arrives as a mouse report,
      // not text — strip it so the sequence never lands in the filename.
      const typed = stripMouseSequences(input);
      if (typed && !/[\r\n\t]/.test(typed)) {
        setFilename((prev) => prev.slice(0, cursor) + typed + prev.slice(cursor));
        setCursor((c) => c + typed.length);
      }
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }
    if (phase === "result") {
      if (key.return) onCancel();
      return;
    }

    if (key.return) {
      if (selected === TOGGLE_ROW) {
        setIncludeThinking((t) => !t);
      } else if (EXPORT_OPTIONS[selected]?.id === "clipboard") {
        runCopy();
      } else {
        if (onSaveToFile) {
          setScreen("filename");
        } else {
          runFile();
        }
      }
      return;
    }
    if (key.upArrow) {
      setSelected((s) => Math.min(ROW_COUNT - 1, s + 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }

    if (key.tab || input === " " || input === "t" || input === "T") {
      setIncludeThinking((t) => !t);
    }
  });

  // Reference input guide: the option list implies Enter, so it advertises
  // only Esc; the filename step adds Enter to save (ExportDialog.renderInputGuide).
  const guide =
    phase === "working" ? (
      <Text>Exporting…</Text>
    ) : screen === "filename" ? (
      <Text>Enter to save · Esc to go back</Text>
    ) : (
      <Text>Esc to cancel</Text>
    );

  return (
    <Dialog
      title="Export Conversation"
      subtitle="Select export method:"
      color="permission"
      onCancel={() => {

        if (screen === "filename") {
          setScreen("options");
          return;
        }
        onCancel();
      }}
      cancelActive={screen !== "filename"}
      footer={guide}
    >
      {screen === "options" ? (
        <>
          {EXPORT_OPTIONS.map((opt, i) => {
            const active = i === selected;
            return (
              <Box key={opt.id} flexDirection="column">
                <Text color={active ? token("suggestion") : undefined} bold={active}>
                  {active ? "❯ " : "  "}
                  {opt.label}
                </Text>
                <Text dimColor>{"  "}{opt.description}</Text>
              </Box>
            );
          })}
          {}
          <Box flexDirection="column" marginTop={1}>
            <Text color={TOGGLE_ROW === selected ? token("suggestion") : undefined} bold={TOGGLE_ROW === selected}>
              {TOGGLE_ROW === selected ? "❯ " : "  "}
              <Text inverse={includeThinking} color={includeThinking ? token("success") : token("inactive")}>
                {includeThinking ? " [x]" : " [ ]"}
              </Text>
              Include thinking/reasoning
            </Text>
            <Text dimColor>{"  "}(model reasoning text)</Text>
          </Box>
        </>
      ) : (
        <Box flexDirection="column">
          <Text>Enter filename:</Text>
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Text>&gt;</Text>
            <Text>
              {filename.slice(0, cursor)}
              <Text inverse>{filename[cursor] ?? " "}</Text>
              {filename.slice(cursor + 1)}
            </Text>
          </Box>
        </Box>
      )}

      {phase === "result" && result && (
        <>
          <Text color={result.success ? token("success") : token("error")}>
            {result.success ? "✓ " : "✗ "}
            {result.message}
          </Text>
          <Text dimColor>  Enter or Esc to close</Text>
        </>
      )}
    </Dialog>
  );
}
