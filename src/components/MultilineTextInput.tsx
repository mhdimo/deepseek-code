// Custom multiline text input using Ink's useInput
// Replaces ink-text-input (single-line only) with full multiline support.
// Enter submits, Alt+Enter / Ctrl+J inserts newline.
//
// Issues fixed:
// - Cursor and text rendering are memoized to prevent Ink re-painting
//   the full text area on every keystroke (causes flicker).
// - useInput is deactivated when overlays are open to avoid
//   competing with App-level keybindings.
// - Cursor sync tracks internal vs external value changes correctly.
// - Memoized render output avoids rebuilding React element tree on every
//   keystroke — only re-renders when value or cursorOffset actually change.
// - cursorRef keeps the cursor position in a ref so the useInput handler
//   always reads the latest position, even when multiple keystrokes arrive
//   between React re-renders. Without this, the stale `cursorOffset` from
//   the closure would insert characters at the wrong position, making it
//   look like letters are being eaten or swapped during fast typing.

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { theme, resolveColor } from "../utils/theme.js";


interface MultilineTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  focus: boolean;
  placeholder?: string;
  isPickerActive?: boolean;
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

// ── Render helpers ─────────────────────────────────────────────────────────

/** Placeholder view — reference behavior (renderPlaceholder hook): dim text;
 *  the first char is inverted only while the input is focused. */
function renderPlaceholder(placeholder: string, focused: boolean): React.ReactNode {
  const ph = placeholder || " ";
  if (!focused) {
    return <Text dimColor>{ph}</Text>;
  }
  return (
    <Text>
      <Text backgroundColor={resolveColor(theme.promptBorder)} color={resolveColor(theme.inverseText)}>
        {ph[0] || " "}
      </Text>
      <Text dimColor>{ph.slice(1)}</Text>
    </Text>
  );
}

/** Build the cursor-highlighted text segments. */
function renderTextContent(
  value: string,
  cursorOffset: number,
): React.ReactNode {
  if (value === "") return null;

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
          <Text backgroundColor={resolveColor(theme.promptBorder)} color={resolveColor(theme.inverseText)}>
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

// ── Component ───────────────────────────────────────────────────────────────

const MultilineTextInput = React.memo(function MultilineTextInput({
  value,
  onChange,
  onSubmit,
  focus,
  placeholder = "",
  isPickerActive = false,
}: MultilineTextInputProps) {
  // Internal mutable buffer — we write to this ref synchronously on every
  // keystroke so rapid typing doesn't race against React's async re-render.
  // Without this, two keystrokes between renders share the same stale `value`
  // prop and the first character is silently dropped ("eating words").
  const bufferRef = useRef(value);
  const [cursorOffset, setCursorOffset] = useState(0);
  const cursorRef = useRef(0); // sync'd with setCursorOffset so useInput always reads latest
  const prevExternalValue = useRef(value);
  // Track whether the last onChange was internal (from useInput) vs external
  const internalChange = useRef(false);

  // Sync cursor when value changes externally (history nav, command picker)
  useEffect(() => {
    if (internalChange.current) {
      internalChange.current = false;
      prevExternalValue.current = value;
      bufferRef.current = value;
      return;
    }
    if (value !== prevExternalValue.current) {
      bufferRef.current = value;
      cursorRef.current = value.length;
      setCursorOffset(value.length);
      prevExternalValue.current = value;
    }
  }, [value]);

  // ── Stabilize the useInput handler ──────────────────────────────────────
  // Keep refs for props used in the handler so the handler function reference
  // stays stable across renders. This prevents Ink's useInput from
  // deregistering/re-registering the input listener on every keystroke
  // (use-input.js line 121: effect dep on inputHandler).
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const isPickerActiveRef = useRef(isPickerActive);
  isPickerActiveRef.current = isPickerActive;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handleInput = useCallback(
    (input: string, key: import("ink").Key) => {
      const pos = cursorRef.current; // always reads latest cursor position

      // -- Submit: plain Enter (no meta)
      if (key.return && !key.meta) {
        if (!isPickerActiveRef.current) {
          onSubmitRef.current();
        }
        return;
      }

      // -- Newline: Alt+Enter or Ctrl+J
      // Alt+Enter: key.return=true, key.meta=true
      // Ctrl+J produces '\n' character — detected as input==='\n' with key.return===false
      if ((key.return && key.meta) || (!key.return && input === "\n")) {
        const curVal = bufferRef.current;
        const newValue =
          curVal.slice(0, pos) + "\n" + curVal.slice(pos);
        bufferRef.current = newValue;
        internalChange.current = true;
        prevExternalValue.current = newValue;
        const nextPos = pos + 1;
        cursorRef.current = nextPos;
        setCursorOffset(nextPos);
        onChangeRef.current(newValue);
        return;
      }

      // -- Backspace (also handle key.delete — Ink maps \x7f (Linux backspace) to delete)
      if (key.backspace || key.delete || (key.ctrl && input === "h")) {
        if (pos > 0) {
          const curVal = bufferRef.current;
          const newValue =
            curVal.slice(0, pos - 1) + curVal.slice(pos);
          bufferRef.current = newValue;
          internalChange.current = true;
          prevExternalValue.current = newValue;
          const nextPos = pos - 1;
          cursorRef.current = nextPos;
          setCursorOffset(nextPos);
          onChangeRef.current(newValue);
        }
        return;
      }

      // -- Left arrow
      if (key.leftArrow) {
        if (pos > 0) {
          const nextPos = pos - 1;
          cursorRef.current = nextPos;
          setCursorOffset(nextPos);
        }
        return;
      }

      // -- Right arrow
      if (key.rightArrow) {
        if (pos < bufferRef.current.length) {
          const nextPos = pos + 1;
          cursorRef.current = nextPos;
          setCursorOffset(nextPos);
        }
        return;
      }

      // -- Home: start of current line
      if (key.home) {
        const curVal = bufferRef.current;
        const nextPos = lineStart(curVal, Math.min(pos, curVal.length));
        cursorRef.current = nextPos;
        setCursorOffset(nextPos);
        return;
      }

      // -- End: end of current line
      if (key.end) {
        const curVal = bufferRef.current;
        const nextPos = lineEnd(curVal, Math.min(pos, curVal.length));
        cursorRef.current = nextPos;
        setCursorOffset(nextPos);
        return;
      }

      // -- Ctrl+A: start of line (unless Ctrl+A is used for select-all)
      if (key.ctrl && input === "a") {
        const curVal = bufferRef.current;
        const nextPos = lineStart(curVal, Math.min(pos, curVal.length));
        cursorRef.current = nextPos;
        setCursorOffset(nextPos);
        return;
      }

      // -- Ctrl+E: end of line
      if (key.ctrl && input === "e") {
        const curVal = bufferRef.current;
        const nextPos = lineEnd(curVal, Math.min(pos, curVal.length));
        cursorRef.current = nextPos;
        setCursorOffset(nextPos);
        return;
      }

      // -- Ctrl+U: delete from cursor to start of line
      if (key.ctrl && input === "u") {
        const curVal = bufferRef.current;
        const start = lineStart(curVal, pos);
        const newValue = curVal.slice(0, start) + curVal.slice(pos);
        bufferRef.current = newValue;
        internalChange.current = true;
        prevExternalValue.current = newValue;
        cursorRef.current = start;
        setCursorOffset(start);
        onChangeRef.current(newValue);
        return;
      }

      // -- Ctrl+K: delete from cursor to end of line
      if (key.ctrl && input === "k") {
        const curVal = bufferRef.current;
        const end = lineEnd(curVal, pos);
        const newValue = curVal.slice(0, pos) + curVal.slice(end);
        bufferRef.current = newValue;
        internalChange.current = true;
        prevExternalValue.current = newValue;
        onChangeRef.current(newValue);
        return;
      }

      // -- Ctrl+W: delete word backwards
      if (key.ctrl && input === "w") {
        if (pos === 0) return;
        const curVal = bufferRef.current;
        let wordStart = pos - 1;
        // Skip whitespace
        while (wordStart > 0 && curVal[wordStart] === " ") wordStart--;
        // Skip word chars
        while (wordStart > 0 && curVal[wordStart - 1] !== " " && curVal[wordStart - 1] !== "\n")
          wordStart--;
        const newValue = curVal.slice(0, wordStart) + curVal.slice(pos);
        bufferRef.current = newValue;
        internalChange.current = true;
        prevExternalValue.current = newValue;
        cursorRef.current = wordStart;
        setCursorOffset(wordStart);
        onChangeRef.current(newValue);
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

      // -- Printable character or paste: insert at cursor (ignore control characters)
      if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 32) {
        const curVal = bufferRef.current;
        const newValue =
          curVal.slice(0, pos) + input + curVal.slice(pos);
        bufferRef.current = newValue;
        internalChange.current = true;
        prevExternalValue.current = newValue;
        const nextPos = pos + input.length;
        cursorRef.current = nextPos;
        setCursorOffset(nextPos);
        onChangeRef.current(newValue);
      }
    },
    [], // stable — all externals accessed via refs
  );

  useInput(handleInput, { isActive: focus });

  // ── Render ────────────────────────────────────────────────────────────────

  // Always render the same outer <Box> structure so Ink's incremental renderer
  // doesn't lose its terminal position when transitioning between empty and
  // non-empty states. The inner content changes, but the layout root stays
  // stable — no more "doesn't refresh on the same line" bug.
  return (
    <Box flexDirection="column" flexGrow={1}>
      {value === ""
        ? renderPlaceholder(placeholder, focus)
        : renderTextContent(value, cursorOffset)}
    </Box>
  );
});

export default MultilineTextInput;
