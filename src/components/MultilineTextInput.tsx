

















import React, { useState, useRef, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import { isMouseSequence, stripMouseSequences } from "./useMouseWheelScroll.js";
import { closesPaste, normalizePaste, opensPaste, pasteInFlight } from "./paste.js";
import { findUltrathinkPositions, type KeywordRange } from "../utils/thinkingKeywords.js";


interface MultilineTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  focus: boolean;
  placeholder?: string;
  isPickerActive?: boolean;
  /** Colour for the typed text. Unset (the default) leaves the terminal's own
   *  foreground; the permission dialog's focused input row passes the
   *  `suggestion` token so the label, its separator and the value read as one
   *  editable field. */
  color?: string;
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

/** Zero-based (line, column) of a cursor offset in a multi-line buffer. */
function lineColOf(value: string, cursorOffset: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  for (let i = 0; i < cursorOffset && i < value.length; i++) {
    if (value[i] === "\n") {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

/** Start/end offsets of a zero-based line index (end excludes the newline). */
function lineBounds(value: string, lineIdx: number): { start: number; end: number } {
  let line = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\n") {
      if (line === lineIdx) return { start, end: i };
      line++;
      start = i + 1;
    }
  }
  return { start, end: value.length };
}

/** Cursor after moving one visual line up/down, keeping the column (clamped).
 *  Returns the unchanged offset when already on the first/last line. */
export function moveCursorVertically(value: string, pos: number, dir: -1 | 1): number {
  const { line, col } = lineColOf(value, pos);
  const target = line + dir;
  const totalLines = value.split("\n").length;
  if (target < 0 || target >= totalLines) return pos;
  const { start, end } = lineBounds(value, target);
  return Math.min(start + col, end);
}

/**
 * Stitch a chunk onto the one before it when a read boundary landed between
 * the CR and the LF of a line break.
 *
 * A terminal writes CRLF for a pasted line ending, and it writes more than one
 * line at a time, so the OS hands us whatever a read happened to end at — which
 * for a paste of any size is regularly *mid-break*: one chunk ends on the CR,
 * the next begins with the LF. Each half normalises to a line feed of its own
 * (paste.ts sees one chunk at a time and cannot know the other half exists), so
 * a 4KB read size doubles a break every 4KB of paste — a hundred-line paste
 * pasted from a file with CRLF endings came out with its lines spaced out.
 *
 * The pair has to be remembered *across* events, which is why the state is here
 * rather than in the normaliser: the two halves arrive as two calls.
 *
 * `pendingCR` says the previous chunk ended on a bare CR — a chunk ending in
 * CRLF does not set it, that break is already whole.
 */
export function joinChunk(text: string, pendingCR: boolean): { text: string; pendingCR: boolean } {
  return {
    text: pendingCR && text.startsWith("\n") ? text.slice(1) : text,
    pendingCR: text.endsWith("\r"),
  };
}




function renderPlaceholder(placeholder: string, focused: boolean): React.ReactNode {
  const ph = placeholder || " ";
  if (!focused) {
    return <Text dimColor>{ph}</Text>;
  }
  return (
    <Text>
      {/* The cursor block inverts the terminal's own colours (chalk.inverse in
          the reference), so it follows the user's palette instead of painting
          a fixed grey block. */}
      <Text inverse>{ph[0] || " "}</Text>
      <Text dimColor>{ph.slice(1)}</Text>
    </Text>
  );
}


// Rainbow palette for the ultrathink keyword (Claude Code parity — the word
// glows char-by-char while you type it).
const RAINBOW_COLORS = [
  theme.rainbow_red,
  theme.rainbow_orange,
  theme.rainbow_yellow,
  theme.rainbow_green,
  theme.rainbow_blue,
  theme.rainbow_indigo,
  theme.rainbow_violet,
] as const;

/** Render a string slice, coloring chars that fall inside an ultrathink
 *  range with the cycling rainbow. `absStart` is the slice's offset in the
 *  full buffer so the rainbow phase stays continuous across lines. */
function renderRainbowSlice(
  slice: string,
  absStart: number,
  ranges: readonly KeywordRange[],
): React.ReactNode {
  if (slice.length === 0 || ranges.length === 0) return slice;
  const rel: KeywordRange[] = [];
  for (const r of ranges) {
    const start = Math.max(0, r.start - absStart);
    const end = Math.min(slice.length, r.end - absStart);
    if (end > start) rel.push({ start, end });
  }
  if (rel.length === 0) return slice;

  const spans: React.ReactNode[] = [];
  let cursor = 0;
  rel.forEach((r, i) => {
    if (r.start > cursor) spans.push(slice.slice(cursor, r.start));
    for (let p = r.start; p < r.end; p++) {
      spans.push(
        <Text key={`u${i}-${p}`} color={resolveColor(RAINBOW_COLORS[(absStart + p) % RAINBOW_COLORS.length]!)}>
          {slice[p]}
        </Text>,
      );
    }
    cursor = r.end;
  });
  if (cursor < slice.length) spans.push(slice.slice(cursor));
  return spans;
}

function renderTextContent(
  value: string,
  cursorOffset: number,
  color?: string,
): React.ReactNode {
  if (value === "") return null;

  const ultrathinkRanges = findUltrathinkPositions(value);
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
        <Text key={lineIdx} color={color}>
          {renderRainbowSlice(before, lineStartOff, ultrathinkRanges)}
          <Text inverse>{cursorChar}</Text>
          {renderRainbowSlice(after, lineStartOff + colInLine + 1, ultrathinkRanges)}
        </Text>,
      );
    } else {
      elements.push(
        <Text key={lineIdx} color={color}>{renderRainbowSlice(line || " ", lineStartOff, ultrathinkRanges)}</Text>,
      );
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
  color,
}: MultilineTextInputProps) {
  
  
  
  
  const bufferRef = useRef(value);
  const [cursorOffset, setCursorOffset] = useState(0);
  const cursorRef = useRef(0); 
  const prevExternalValue = useRef(value);
  
  const internalChange = useRef(false);

  // A bracketed paste that has opened and not yet closed, and when it was last
  // heard from. While it is open an Enter is paste content rather than a
  // submission — see paste.ts.
  const pasteOpenRef = useRef(false);
  const pasteOpenAtRef = useRef(0);

  // Whether the last chunk handled ended on the CR of a CRLF, so the chunk
  // after it may open with that line break's other half — see joinChunk.
  const pendingCRRef = useRef(false);

  
  useEffect(() => {
    if (internalChange.current) {
      internalChange.current = false;
      // A prop commit can lag behind keystrokes already sitting in bufferRef
      // (the effect fires after a newer key event was handled). Replaying the
      // stale prop over the buffer silently deletes what was typed in between
      // — acknowledge up to the LATEST local edit instead.
      prevExternalValue.current = bufferRef.current;
      return;
    }
    if (value !== prevExternalValue.current && value !== bufferRef.current) {
      // Genuine external change (history recall, picker fill, submit clear).
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
      // prompt buffer. A chunk can also carry a report glued to real
      // keystrokes (a click landing between two of them, or two reports
      // batched into one read), so strip the reports rather than rejecting the
      // chunk whole and losing what was typed alongside them.
      if (isMouseSequence(input)) return;
      const typed = stripMouseSequences(input);
      if (typed !== input) input = typed;
      const pos = cursorRef.current;

      // The two halves of a split line break are adjacent reads, so a CR is
      // only half of one if the very next event carries the LF. Anything in
      // between means that CR ended a line on its own, and the next chunk's
      // leading LF — if it has one — is a line feed of its own to keep. The
      // chunk is rejoined before anything reads it, so every branch below works
      // on the text the user actually typed rather than half of it; only an
      // inserted chunk can leave a CR for the next one to pair with (the
      // assignment in the insert branch), because an Enter that submitted is
      // done with this paste's bytes.
      const pendingCR = pendingCRRef.current;
      pendingCRRef.current = false;
      const rejoined = joinChunk(input, pendingCR);
      input = rejoined.text;


      if (key.return && !key.meta) {
        // Mid-paste an Enter is content, not a submission: a large paste is
        // read in chunks and the split can land on a line break, so the lone
        // CR arrives looking like the user hitting return. Past this check the
        // event falls through to the insert branch below, which turns the CR
        // into a line feed — the only place a bare CR is welcome.
        if (!pasteInFlight(pasteOpenRef.current, pasteOpenAtRef.current, Date.now())) {
          if (!isPickerActiveRef.current) {
            onSubmitRef.current();
          }
          return;
        }
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

      // Up/down move the cursor between lines of a multi-line draft. On a
      // single-line draft this is a no-op here; App's handler turns it into
      // history recall — but it must never fire while a multi-line draft is
      // being edited, or the draft would be clobbered by a history entry.
      if (key.upArrow || key.downArrow) {
        const curVal = bufferRef.current;
        const nextPos = moveCursorVertically(curVal, Math.min(pos, curVal.length), key.upArrow ? -1 : 1);
        if (nextPos !== pos) {
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


      if (input && !key.ctrl && !key.meta) {
        // A paste arrives here as one chunk. Normalise it — CR to LF, no
        // bracketed-paste markers, no escape sequences — and insert whatever
        // text is underneath. See paste.ts for the shapes ink actually
        // delivers, and for what it cost to insert them raw.
        const text = normalizePaste(input);
        if (opensPaste(input)) {
          pasteOpenRef.current = true;
          pasteOpenAtRef.current = Date.now();
        } else if (closesPaste(input)) {
          pasteOpenRef.current = false;
        } else if (pasteOpenRef.current) {
          // A chunk inside an open paste: keep its claim on Enter fresh.
          pasteOpenAtRef.current = Date.now();
        }
        if (text.length > 0) {
          pendingCRRef.current = rejoined.pendingCR;
          const curVal = bufferRef.current;
          const newValue = curVal.slice(0, pos) + text + curVal.slice(pos);
          bufferRef.current = newValue;
          internalChange.current = true;
          prevExternalValue.current = newValue;
          const nextPos = pos + text.length;
          cursorRef.current = nextPos;
          setCursorOffset(nextPos);
          onChangeRef.current(newValue);
        }
      }
    },
    [], 
  );

  useInput(handleInput, { isActive: focus });

  

  
  
  
  
  return (
    <Box flexDirection="column" flexGrow={1}>
      {value === ""
        ? renderPlaceholder(placeholder, focus)
        : renderTextContent(value, cursorOffset, color)}
    </Box>
  );
});

export default MultilineTextInput;
