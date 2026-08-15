import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select } from "../ui/design-system/Select.js";
import { resolveColor, theme } from "../utils/theme.js";
import type { Message } from "../types/index.js";
import { hasSnapshot, restoreSnapshot } from "../utils/fileHistory.js";
import stringWidth from "string-width";

/** What a rewind restores: the conversation, the snapshotted files, or both. */
export type RewindMode = "both" | "conversation" | "code";

export interface RewindPickerProps {
  messages: Message[];
  /** Working directory — snapshot paths resolve against it. */
  workingDirectory: string;
  /**
   * App performs the actual restore. Return a promise that rejects on
   * failure so the picker can surface the error inline.
   */
  onRewind: (messageNumber: number, mode: RewindMode) => Promise<void> | void;
  onClose: () => void;
  /** App-reported restore failure — rendered in red when present. */
  error?: string | null;
}

export interface SelectableUserMessage {
  /** 1-based position in the FULL messages array (the rewind target depth). */
  number: number;
  message: Message;
}

/** User messages with non-empty content, numbered by full-array position. */
export function selectableUserMessages(messages: Message[]): SelectableUserMessage[] {
  const selected: SelectableUserMessage[] = [];
  messages.forEach((message, i) => {
    if (message.role === "user" && message.content.trim().length > 0) {
      selected.push({ number: i + 1, message });
    }
  });
  return selected;
}

/** First line of the message, truncated to `maxCols` display columns. */
export function previewLine(message: Message, maxCols = 70): string {
  const firstLine = message.content.split("\n")[0]?.trim() ?? "";
  if (stringWidth(firstLine) <= maxCols) return firstLine;
  let result = "";
  let width = 0;
  for (const char of firstLine) {
    const charWidth = stringWidth(char);
    if (width + charWidth > maxCols - 1) break;
    result += char;
    width += charWidth;
  }
  return `${result}…`;
}

/**
 * Number of snapshot files whose stored content differs from the current
 * on-disk state. Null means no snapshot exists at this message.
 */
export async function countFilesChanged(
  messageNumber: number,
  workingDirectory: string,
): Promise<number | null> {
  if (!hasSnapshot(messageNumber)) return null;
  const entries = await restoreSnapshot(messageNumber, workingDirectory);
  let changed = 0;
  for (const entry of entries) {
    let disk: string | null = null;
    try {
      disk = await Bun.file(entry.path).text();
    } catch {
      disk = null;
    }
    if (entry.content !== disk) changed++;
  }
  return changed;
}

type ConfirmValue = RewindMode | "nevermind";

/**
 * Interactive /rewind picker (Claude Code MessageSelector equivalent). Two
 * stages: choose a user message, then choose what to restore — conversation,
 * snapshotted code, both, or never mind. Each list entry shows how many
 * snapshot files differ from the current disk state; the actual restore
 * runs in App via onRewind (whose rejection surfaces as a red error line).
 */
export default function RewindPicker({
  messages,
  workingDirectory,
  onRewind,
  onClose,
  error,
}: RewindPickerProps): React.ReactElement {
  const [stage, setStage] = useState<"list" | "confirm">("list");
  const [selectedNumber, setSelectedNumber] = useState(0);
  const [counts, setCounts] = useState<Record<number, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const options = useMemo(() => selectableUserMessages(messages), [messages]);

  // Load the files-changed count for every option that has a snapshot.
  useEffect(() => {
    let cancelled = false;
    const numbers = options.filter((o) => hasSnapshot(o.number)).map((o) => o.number);
    void Promise.all(
      numbers.map(async (n) => {
        let count: number | null;
        try {
          count = await countFilesChanged(n, workingDirectory);
        } catch {
          count = null;
        }
        if (!cancelled) setCounts((prev) => ({ ...prev, [n]: count }));
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [options, workingDirectory]);

  const selected = options.find((o) => o.number === selectedNumber) ?? null;
  const canRestoreCode = selected ? hasSnapshot(selected.number) : false;

  const listOptions = useMemo(
    () =>
      options.map((o) => {
        const count = counts[o.number];
        const description =
          count === undefined
            ? undefined
            : count === null
              ? "⚠ No code restore"
              : `${count} file${count === 1 ? "" : "s"} changed`;
        return {
          value: String(o.number),
          label: `#${o.number} ${previewLine(o.message)}`,
          description,
        };
      }),
    [options, counts],
  );

  const confirmOptions = useMemo<Array<{ label: string; value: ConfirmValue; description?: string }>>(() => {
    const count = selected ? counts[selected.number] : undefined;
    const countDescription =
      count === undefined ? undefined : `${count} file${count === 1 ? "" : "s"} changed`;
    const restoreOptions: Array<{ label: string; value: RewindMode; description?: string }> =
      canRestoreCode
        ? [
            { label: "Restore code and conversation", value: "both", description: countDescription },
            { label: "Restore conversation", value: "conversation" },
            { label: "Restore code", value: "code", description: countDescription },
          ]
        : [{ label: "Restore conversation", value: "conversation" }];
    return [...restoreOptions, { label: "Never mind", value: "nevermind" }];
  }, [canRestoreCode, counts, selected]);

  useInput((_input, key) => {
    if (busy) return;
    if (key.escape) {
      if (stage === "confirm") setStage("list");
      else onClose();
    }
  });

  const handleSelectMessage = (value: string) => {
    const number = Number(value);
    if (options.some((o) => o.number === number)) {
      setSelectedNumber(number);
      setLocalError(null);
      setStage("confirm");
    }
  };

  const handleConfirm = async (value: ConfirmValue) => {
    if (value === "nevermind") {
      setStage("list");
      return;
    }
    if (!selected) {
      setLocalError("Message not found.");
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      await onRewind(selected.number, value);
      onClose();
    } catch (e) {
      setBusy(false);
      setLocalError(e instanceof Error ? e.message : String(e));
    }
  };

  const shownError = error ?? localError;

  return (
    <Dialog
      title={stage === "list" ? "Rewind conversation" : `Rewind to message #${selectedNumber}`}
      subtitle={
        stage === "list"
          ? "Choose a past message — snapshotted files can be restored with it"
          : "Choose what to restore"
      }
      onCancel={onClose}
      cancelActive={false}
      footer={
        stage === "list" ? (
          <>
            <Text bold>↑↓</Text> to choose · <Text bold>enter</Text> to select · <Text bold>esc</Text> to cancel
          </>
        ) : (
          <>
            <Text bold>↑↓</Text> to choose · <Text bold>enter</Text> to restore · <Text bold>esc</Text> to go back
          </>
        )
      }
    >
      {stage === "list" ? (
        <Select
          key="list"
          options={listOptions}
          defaultValue={listOptions[listOptions.length - 1]?.value}
          onChange={handleSelectMessage}
          onCancel={onClose}
          visibleOptionCount={8}
        />
      ) : (
        <>
          {selected && (
            <Box flexDirection="column" marginBottom={1}>
              <Text dimColor>{previewLine(selected.message)}</Text>
              {!canRestoreCode && <Text dimColor>⚠ No code restore</Text>}
            </Box>
          )}
          <Box marginBottom={1}>
            <Text color={resolveColor(theme.warning)}>
              ⚠ Rewinding does not affect files edited manually or via bash.
            </Text>
          </Box>
          <Select
            key="confirm"
            options={confirmOptions}
            defaultValue={canRestoreCode ? "both" : "conversation"}
            onChange={(value) => void handleConfirm(value)}
            onCancel={() => setStage("list")}
            keysActive={!busy}
            visibleOptionCount={6}
          />
          {busy && (
            <Box marginTop={1}>
              <Text dimColor>Restoring…</Text>
            </Box>
          )}
        </>
      )}
      {shownError && (
        <Box marginTop={1}>
          <Text color={resolveColor(theme.error)}>Error: {shownError}</Text>
        </Box>
      )}
    </Dialog>
  );
}
