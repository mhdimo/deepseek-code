

















import React, { useState, useRef, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import { isMouseSequence } from "./useMouseWheelScroll.js";


interface MultilineTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  focus: boolean;
  placeholder?: string;
  isPickerActive?: boolean;
}



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

function isWordSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Cursor at the start of the previous word: skip trailing whitespace, then
 *  the word chars before it (readline backward-word). */
export function skipWordLeft(value: string, pos: number): number {
  let i = Math.min(pos, value.length);
  while (i > 0 && isWordSpace(value[i - 1]!)) i--;
  while (i > 0 && !isWordSpace(value[i - 1]!)) i--;
  return i;
}

/** Cursor at the start of the next word: from inside a word, skip the word
 *  and the whitespace after it; from whitespace, skip to the next word. */
export function skipWordRight(value: string, pos: number): number {
  const len = value.length;
  let i = Math.min(pos, len);
  if (i < len && isWordSpace(value[i]!)) {
    while (i < len && isWordSpace(value[i]!)) i++;
    return i;
  }
  while (i < len && !isWordSpace(value[i]!)) i++;
  while (i < len && isWordSpace(value[i]!)) i++;
  return i;
}




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



const MultilineTextInput = React.memo(function MultilineTextInput({
  value,
  onChange,
  onSubmit,
  focus,
  placeholder = "",
  isPickerActive = false,
}: MultilineTextInputProps) {
  
  
  
  
  const bufferRef = useRef(value);
  const [cursorOffset, setCursorOffset] = useState(0);
  const cursorRef = useRef(0); 
  const prevExternalValue = useRef(value);
  
  const internalChange = useRef(false);

  
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

  
  
  
  
  
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const isPickerActiveRef = useRef(isPickerActive);
  isPickerActiveRef.current = isPickerActive;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handleInput = useCallback(
    (input: string, key: import("ink").Key) => {
      // Terminal mouse sequences reach every useInput handler as a raw string
      // like `[<64;10;15M` with an empty key name — never type them into the
      // prompt buffer.
      if (isMouseSequence(input)) return;
      const pos = cursorRef.current;


      if (key.return && !key.meta) {
        if (!isPickerActiveRef.current) {
          onSubmitRef.current();
        }
        return;
      }

      
      
      
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

      // Word-jump cursor movement: Option/Alt+Left/Right (macOS; xterm
      // modifier form `\x1b[1;3D/C`), Ctrl+Left/Right (Windows Terminal
      // `\x1b[1;5D/C`), and the readline bindings ESC+b / ESC+f (iTerm's
      // default Option+arrow form, delivered as meta + 'b'/'f').
      let wordDir = 0;
      if (key.leftArrow && (key.meta || key.ctrl)) wordDir = -1;
      else if (key.rightArrow && (key.meta || key.ctrl)) wordDir = 1;
      else if (key.meta && (input === "b" || input === "B")) wordDir = -1;
      else if (key.meta && (input === "f" || input === "F")) wordDir = 1;
      if (wordDir !== 0) {
        const curVal = bufferRef.current;
        const nextPos = wordDir < 0 ? skipWordLeft(curVal, pos) : skipWordRight(curVal, pos);
        if (nextPos !== pos) {
          cursorRef.current = nextPos;
          setCursorOffset(nextPos);
        }
        return;
      }


      if (key.leftArrow) {
        if (pos > 0) {
          const nextPos = pos - 1;
          cursorRef.current = nextPos;
          setCursorOffset(nextPos);
        }
        return;
      }


      if (key.rightArrow) {
        if (pos < bufferRef.current.length) {
          const nextPos = pos + 1;
          cursorRef.current = nextPos;
          setCursorOffset(nextPos);
        }
        return;
      }

      
      if (key.home) {
        const curVal = bufferRef.current;
        const nextPos = lineStart(curVal, Math.min(pos, curVal.length));
        cursorRef.current = nextPos;
        setCursorOffset(nextPos);
        return;
      }

      
      if (key.end) {
        const curVal = bufferRef.current;
        const nextPos = lineEnd(curVal, Math.min(pos, curVal.length));
        cursorRef.current = nextPos;
        setCursorOffset(nextPos);
        return;
      }

      
      if (key.ctrl && input === "a") {
        const curVal = bufferRef.current;
        const nextPos = lineStart(curVal, Math.min(pos, curVal.length));
        cursorRef.current = nextPos;
        setCursorOffset(nextPos);
        return;
      }

      
      if (key.ctrl && input === "e") {
        const curVal = bufferRef.current;
        const nextPos = lineEnd(curVal, Math.min(pos, curVal.length));
        cursorRef.current = nextPos;
        setCursorOffset(nextPos);
        return;
      }

      
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

      
      if (key.ctrl && input === "w") {
        if (pos === 0) return;
        const curVal = bufferRef.current;
        let wordStart = pos - 1;
        
        while (wordStart > 0 && curVal[wordStart] === " ") wordStart--;
        
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
    [], 
  );

  useInput(handleInput, { isActive: focus });

  

  
  
  
  
  return (
    <Box flexDirection="column" flexGrow={1}>
      {value === ""
        ? renderPlaceholder(placeholder, focus)
        : renderTextContent(value, cursorOffset)}
    </Box>
  );
});

export default MultilineTextInput;
