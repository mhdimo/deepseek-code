/**
 * Click cell → buffer offset. The grid the mapping walks must match what ink
 * renders: wrap-ansi v9 with ink's own options ({ trim: false, hard: true }),
 * one logical line at a time (ink renders one Text per logical line).
 */
import { describe, expect, test } from "bun:test";
import wrapAnsi from "wrap-ansi";
import { visualOffsetAt } from "../../src/components/inputClickMapping.js";

describe("the wrap grid matches ink's", () => {
  test("wraps exactly as ink's wrap-text does", () => {
    // Pinned against ink's options; if wrap-ansi's behavior changes under us
    // this test is the alarm, not a mystery cursor.
    expect(wrapAnsi("abcd ef", 4, { trim: false, hard: true }).split("\n")).toEqual([
      "abcd",
      " ef",
    ]);
    expect(wrapAnsi("aaaaa", 4, { trim: false, hard: true }).split("\n")).toEqual([
      "aaaa",
      "a",
    ]);
  });
});

describe("visualOffsetAt", () => {
  test("cells within one line", () => {
    expect(visualOffsetAt("abc", 20, 0, 0)).toBe(0);
    expect(visualOffsetAt("abc", 20, 0, 1)).toBe(1);
    expect(visualOffsetAt("abc", 20, 0, 3)).toBe(3);
    // Past the end of the text: end of the (visual) line.
    expect(visualOffsetAt("abc", 20, 0, 40)).toBe(3);
  });

  test("a wide char owns both its cells; a mid-char click snaps after it", () => {
    expect(visualOffsetAt("日本語", 20, 0, 0)).toBe(0);
    expect(visualOffsetAt("日本語", 20, 0, 1)).toBe(1);
    expect(visualOffsetAt("日本語", 20, 0, 2)).toBe(1);
    expect(visualOffsetAt("日本語", 20, 0, 4)).toBe(2);
  });

  test("an astral char advances the offset by two UTF-16 units", () => {
    const value = "a😀b";
    expect(visualOffsetAt(value, 20, 0, 1)).toBe(1); // just before the emoji
    expect(visualOffsetAt(value, 20, 0, 2)).toBe(3); // mid-emoji snaps after it
    expect(visualOffsetAt(value, 20, 0, 3)).toBe(3); // the emoji's second cell
    expect(visualOffsetAt(value, 20, 0, 4)).toBe(4); // past the end → the true end
  });

  test("wrapped continuations map through the wrap boundaries", () => {
    const value = "abcd ef";
    expect(visualOffsetAt(value, 4, 1, 0)).toBe(4); // the kept leading space
    expect(visualOffsetAt(value, 4, 1, 1)).toBe(5); // 'e'
    expect(visualOffsetAt(value, 4, 1, 2)).toBe(6); // 'f'
    // Right padding on a continuation row clamps to that row's end.
    expect(visualOffsetAt(value, 4, 1, 3)).toBe(7);
  });

  test("hard-wrapped long words", () => {
    const value = "a".repeat(9);
    expect(visualOffsetAt(value, 4, 1, 0)).toBe(4);
    expect(visualOffsetAt(value, 4, 2, 1)).toBe(9);
  });

  test("logical lines advance the offset past the newline", () => {
    const value = "ab\ncd";
    expect(visualOffsetAt(value, 20, 0, 1)).toBe(1);
    expect(visualOffsetAt(value, 20, 1, 0)).toBe(3);
    expect(visualOffsetAt(value, 20, 1, 2)).toBe(5);
  });

  test("an empty logical line is one blank row", () => {
    const value = "a\n\nb";
    expect(visualOffsetAt(value, 20, 0, 0)).toBe(0);
    expect(visualOffsetAt(value, 20, 1, 0)).toBe(2); // the empty line's row
    expect(visualOffsetAt(value, 20, 2, 0)).toBe(3); // 'b'
  });

  test("a click past a blank row's cell stays on the blank row's slot", () => {
    // The blank row renders a synthetic space for the wrap grid, but there is
    // no buffer character to walk: the row's own slot is the empty line's
    // offset, not one past it.
    expect(visualOffsetAt("a\n\nb", 20, 1, 5)).toBe(2);
  });

  test("a trailing blank row never maps past the end of the buffer", () => {
    const value = "ab\n";
    expect(visualOffsetAt(value, 20, 1, 0)).toBe(value.length);
    expect(visualOffsetAt(value, 20, 1, 5)).toBeLessThanOrEqual(value.length);
  });

  test("below the last row is the end of the buffer; above is the start", () => {
    expect(visualOffsetAt("abc", 20, 7, 2)).toBe(3);
    expect(visualOffsetAt("abc", 20, -1, 2)).toBe(0);
  });

  test("a zero or negative width is treated as one column", () => {
    expect(visualOffsetAt("abc", 0, 0, 0)).toBe(0);
    expect(visualOffsetAt("abc", 0, 1, 0)).toBe(1);
  });

  test("the empty buffer maps to offset 0 on every row", () => {
    expect(visualOffsetAt("", 20, 0, 0)).toBe(0);
    expect(visualOffsetAt("", 20, 3, 9)).toBe(0);
  });

  test("on every row the offset only grows with col and stays inside the buffer", () => {
    const values = ["abc", "a\n\nb", "a😀b", "ab\n", "a".repeat(9), "abcd ef"];
    const failures: string[] = [];
    for (const value of values) {
      for (const width of [4, 20]) {
        for (let row = 0; row < 8; row++) {
          let previous = 0;
          for (let col = 0; col <= 21; col++) {
            const result = visualOffsetAt(value, width, row, col);
            if (result < previous || result < 0 || result > value.length) {
              failures.push(
                `${JSON.stringify(value)} w=${width} row=${row} col=${col} → ${result}`,
              );
            }
            previous = result;
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
