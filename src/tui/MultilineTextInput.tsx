// Custom multiline text input using Ink's useInput
// Replaces ink-text-input (single-line only) with full multiline support.
// Enter submits, Alt+Enter / Ctrl+J inserts newline.

import React, { useState, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";

interface MultilineTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  focus: boolean;
  placeholder?: string;
}

// ── Cursor helpers ──────────────────────────────────────────────────────────

function lineStart(value: string, cursorOffset: number): number {
  let pos = cursorOffset;
  while (pos > 0 && value[pos - 1] !== "\n") pos--;
  return pos;
}

function lineEnd(value: string, cursorOffset: number): number {
  let pos = cursorOffset;
  while (pos < value.length && value[pos] !== "\n") pos++;
  return pos;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function MultilineTextInput({
  value,
  onChange,
  onSubmit,
  focus,
  placeholder = "",
}: MultilineTextInputProps) {
  const [cursorOffset, setCursorOffset] = useState(0);
  const prevExternalValue = useRef(value);
  // Track whether the last onChange was internal (from useInput) vs external
  const internalChange = useRef(false);

  // Sync cursor when value changes externally (history nav, command picker)
  useEffect(() => {
    if (internalChange.current) {
      internalChange.current = false;
      prevExternalValue.current = value;
      return;
    }
    if (value !== prevExternalValue.current) {
      setCursorOffset(value.length);
      prevExternalValue.current = value;
    }
  }, [value]);

  useInput(
    (input, key) => {
      // -- Submit: plain Enter (no meta)
      if (key.return && !key.meta) {
        onSubmit();
        return;
      }

      // -- Newline: Alt+Enter or Ctrl+J
      // Alt+Enter: key.return=true, key.meta=true
      // Ctrl+J produces '\n' character — detected as input==='\n' with key.return===false
      if ((key.return && key.meta) || (!key.return && input === "\n")) {
        const newValue =
          value.slice(0, cursorOffset) + "\n" + value.slice(cursorOffset);
        internalChange.current = true;
        prevExternalValue.current = newValue;
        setCursorOffset(cursorOffset + 1);
        onChange(newValue);
        return;
      }

      // -- Backspace (also handle key.delete — Ink maps \x7f (Linux backspace) to delete)
      if (key.backspace || key.delete || (key.ctrl && input === "h")) {
        if (cursorOffset > 0) {
          const newValue =
            value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
          internalChange.current = true;
          prevExternalValue.current = newValue;
          setCursorOffset(cursorOffset - 1);
          onChange(newValue);
        }
        return;
      }

      // -- Left arrow
      if (key.leftArrow) {
        if (cursorOffset > 0) setCursorOffset(cursorOffset - 1);
        return;
      }

      // -- Right arrow
      if (key.rightArrow) {
        if (cursorOffset < value.length) setCursorOffset(cursorOffset + 1);
        return;
      }

      // -- Home / Ctrl+A: start of current line
      if (key.home) {
        setCursorOffset(lineStart(value, cursorOffset));
        return;
      }

      // -- End: end of current line
      if (key.end) {
        setCursorOffset(lineEnd(value, cursorOffset));
        return;
      }

      // -- Ctrl+A: start of line (unless Ctrl+A is used for select-all)
      if (key.ctrl && input === "a") {
        setCursorOffset(lineStart(value, cursorOffset));
        return;
      }

      // -- Ctrl+E: end of line
      if (key.ctrl && input === "e") {
        setCursorOffset(lineEnd(value, cursorOffset));
        return;
      }

      // -- Ctrl+U: delete from cursor to start of line
      if (key.ctrl && input === "u") {
        const start = lineStart(value, cursorOffset);
        const newValue = value.slice(0, start) + value.slice(cursorOffset);
        internalChange.current = true;
        prevExternalValue.current = newValue;
        setCursorOffset(start);
        onChange(newValue);
        return;
      }

      // -- Ctrl+K: delete from cursor to end of line
      if (key.ctrl && input === "k") {
        const end = lineEnd(value, cursorOffset);
        const newValue = value.slice(0, cursorOffset) + value.slice(end);
        internalChange.current = true;
        prevExternalValue.current = newValue;
        onChange(newValue);
        return;
      }

      // -- Ctrl+W: delete word backwards
      if (key.ctrl && input === "w") {
        if (cursorOffset === 0) return;
        let pos = cursorOffset - 1;
        // Skip whitespace
        while (pos > 0 && value[pos] === " ") pos--;
        // Skip word chars
        while (pos > 0 && value[pos - 1] !== " " && value[pos - 1] !== "\n")
          pos--;
        const newValue = value.slice(0, pos) + value.slice(cursorOffset);
        internalChange.current = true;
        prevExternalValue.current = newValue;
        setCursorOffset(pos);
        onChange(newValue);
        return;
      }

      // -- Skip keys handled elsewhere (Tab, Esc, Ctrl+C, arrows, Shift+Tab, page nav)
      if (
        key.tab ||
        key.escape ||
        (key.ctrl && input === "c") ||
        key.upArrow ||
        key.downArrow ||
        key.pageUp ||
        key.pageDown
      ) {
        return;
      }

      // -- Printable character or paste: insert at cursor
      if (input && !key.ctrl && !key.meta) {
        const newValue =
          value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
        internalChange.current = true;
        prevExternalValue.current = newValue;
        setCursorOffset(cursorOffset + input.length);
        onChange(newValue);
      }
    },
    { isActive: focus },
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (value === "") {
    // Show placeholder with inverse first char
    const ph = placeholder || " ";
    return (
      <Text>
        <Text backgroundColor="gray" color="black">
          {ph[0] || " "}
        </Text>
        <Text dimColor>{ph.slice(1)}</Text>
      </Text>
    );
  }

  const lines = value.split("\n");
  const elements: React.ReactNode[] = [];

  let charCount = 0;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const lineStartOff = charCount;
    const lineEndOff = charCount + line.length;

    if (cursorOffset >= lineStartOff && cursorOffset <= lineEndOff) {
      const colInLine = cursorOffset - lineStartOff;
      const before = line.slice(0, colInLine);
      const cursorChar = line[colInLine] || " ";
      const after = line.slice(colInLine + 1);
      elements.push(
        <Text key={lineIdx}>
          {before}
          <Text backgroundColor="gray" color="black">
            {cursorChar}
          </Text>
          {after}
        </Text>,
      );
    } else {
      elements.push(<Text key={lineIdx}>{line || " "}</Text>);
    }

    charCount += line.length + 1;
  }

  return <Box flexDirection="column">{elements}</Box>;
}
