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
});
