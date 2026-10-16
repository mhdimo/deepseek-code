/**
 * Click cell → buffer offset for a text box.
 *
 * ink's wrap grid is reproduced rather than approximated: ink wraps each text
 * node with `wrapAnsi(text, maxWidth, { trim: false, hard: true })` at the
 * node's computed width (ink/build/wrap-text.js), and renders one Text node
 * per logical line (MultilineTextInput's renderTextContent). Wrapping each
 * logical line the same way gives the identical visual grid.
 *
 * Columns are cell-based (string-width), so wide chars take two cells. A
 * click past a row's text clamps to that row's end — including on a wrapped
 * continuation row, where the text continues on the next row rather than at
 * the end of the logical line.
 */
import wrapAnsi from "wrap-ansi";
import stringWidth from "string-width";

export function visualOffsetAt(value: string, width: number, row: number, col: number): number {
  if (row < 0) return 0;
  const safeWidth = Math.max(1, width);
  const lines = value.split("\n");
  let visualRow = 0;
  let offset = 0;
  for (const line of lines) {
    // An empty logical line renders as one blank row (renderTextContent
    // renders `line || " "`).
    const segments = wrapAnsi(line.length > 0 ? line : " ", safeWidth, {
      trim: false,
      hard: true,
    }).split("\n");
    if (row < visualRow + segments.length) {
      const segmentIndex = row - visualRow;
      const segment = segments[segmentIndex]!;
      // { trim: false } keeps every character, so the segments concatenate
      // back to the logical line: earlier segments of this line are exactly
      // the buffer offset where the clicked row starts.
      let lineOffset = 0;
      for (let i = 0; i < segmentIndex; i++) lineOffset += segments[i]!.length;
      let chars = 0;
      let cells = 0;
      for (const ch of segment) {
        if (cells >= col) break;
        cells += stringWidth(ch);
        chars++;
      }
      return offset + lineOffset + chars;
    }
    visualRow += segments.length;
    offset += line.length + 1; // + the newline itself
  }
  return value.length; // below the last row → end of the buffer
}
