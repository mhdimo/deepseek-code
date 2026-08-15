
import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Dialog } from "../ui/design-system/Dialog.js";
import { theme, resolveColor } from "../utils/theme.js";

export interface InputDialogProps {
  title: string;
  subtitle?: string;
  /** Prefilled value. */
  initial?: string;
  /** Render dots instead of the typed text (API keys). */
  masked?: boolean;
  placeholder?: string;
  /** Allow submitting an empty value (e.g. "clear"). */
  allowEmpty?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Single-line text entry dialog used by /apikey, /baseurl, /statusline and the
 * add-rule / add-hook flows. Cursor editing (arrows, home/end, ctrl+a/e,
 * ctrl+u, ctrl+k, ctrl+w), Enter submits, Escape cancels.
 */
export default function InputDialog({
  title,
  subtitle,
  initial = "",
  masked = false,
  placeholder,
  allowEmpty = false,
  onSubmit,
  onCancel,
}: InputDialogProps): React.ReactElement {
  const [value, setValue] = useState(initial);
  const cursorRef = useRef(initial.length);

  const setCursor = (index: number) => {
    cursorRef.current = Math.max(0, Math.min(value.length, index));
  };

  const insert = (text: string) => {
    const cursor = cursorRef.current;
    setValue((prev) => {
      const next = prev.slice(0, cursor) + text + prev.slice(cursor);
      cursorRef.current = cursor + text.length;
      return next;
    });
  };

  const submit = () => {
    if (!allowEmpty && value.trim().length === 0) return;
    onSubmit(value.trim());
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    if (key.leftArrow) {
      setCursor(cursorRef.current - 1);
      return;
    }
    if (key.rightArrow) {
      setCursor(cursorRef.current + 1);
      return;
    }
    if (key.home || (key.ctrl && input === "a")) {
      setCursor(0);
      return;
    }
    if (key.end || (key.ctrl && input === "e")) {
      setCursor(value.length);
      return;
    }
    if (key.backspace || key.delete) {
      const cursor = cursorRef.current;
      setValue((prev) => {
        const next = prev.slice(0, Math.max(0, cursor - 1)) + prev.slice(cursor);
        cursorRef.current = Math.max(0, cursor - 1);
        return next;
      });
      return;
    }
    if (key.ctrl && input === "u") {
      // Delete from cursor to start (readline behavior).
      const cursor = cursorRef.current;
      setValue((prev) => prev.slice(cursor));
      setCursor(0);
      return;
    }
    if (key.ctrl && input === "k") {
      // Delete from cursor to end.
      const cursor = cursorRef.current;
      setValue((prev) => prev.slice(0, cursor));
      return;
    }
    if (key.ctrl && input === "w") {
      // Delete the previous word.
      const cursor = cursorRef.current;
      setValue((prev) => {
        const before = prev.slice(0, cursor);
        const trimmed = before.replace(/\s+\S*$/, "");
        cursorRef.current = trimmed.length;
        return trimmed + prev.slice(cursor);
      });
      return;
    }
    // Paste arrives as one multi-char input; keys like arrows come with a
    // named key and should not type anything. Terminal mouse sequences
    // ("[<64;10;15M") arrive as raw strings with no named key — drop them.
    const isMouseSequence = input.startsWith("[<");
    if (
      input.length > 0 &&
      !isMouseSequence &&
      !key.ctrl &&
      !key.meta &&
      !key.upArrow &&
      !key.downArrow &&
      !key.tab
    ) {
      insert(input);
    }
  });

  const cursor = cursorRef.current;
  const shown = masked ? "•".repeat(value.length) : value;

  return (
    <Dialog
      title={title}
      subtitle={subtitle}
      onCancel={onCancel}
      cancelActive={false}
      footer={
        <Text>
          <Text bold>enter</Text> to save · <Text bold>esc</Text> to cancel
          {initial ? " · edits start from the current value" : ""}
        </Text>
      }
    >
      <Box>
        <Text color={resolveColor(theme.claude)}>{"> "}</Text>
        {shown.length === 0 && placeholder ? (
          <Text dimColor>{placeholder}</Text>
        ) : (
          <Text>
            {shown.slice(0, cursor)}
            <Text color={resolveColor(theme.claude)} inverse> </Text>
            {shown.slice(cursor)}
          </Text>
        )}
        <Text color={resolveColor(theme.claude)}>▏</Text>
      </Box>
    </Dialog>
  );
}
