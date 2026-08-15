import { describe, expect, test } from "bun:test";

import { skipWordLeft, skipWordRight } from "../../src/components/MultilineTextInput.js";

describe("skipWordLeft", () => {
  test("from the end, lands at the start of the last word", () => {
    expect(skipWordLeft("hello world foo", 15)).toBe(12);
  });

  test("from mid-word, lands at the start of that word", () => {
    expect(skipWordLeft("hello world foo", 13)).toBe(12);
  });

  test("skips multiple spaces", () => {
    expect(skipWordLeft("a   b", 4)).toBe(0);
  });

  test("skips trailing whitespace before the word", () => {
    expect(skipWordLeft("hello world  ", 15)).toBe(6);
  });

  test("jumps to the previous line's last word across a newline", () => {
    expect(skipWordLeft("hello\nworld foo", 12)).toBe(6);
  });

  test("treats tabs as word separators", () => {
    expect(skipWordLeft("hello\tworld", 11)).toBe(6);
  });

  test("stays at 0 when already at the start", () => {
    expect(skipWordLeft("hello world", 0)).toBe(0);
  });

  test("stays at 0 when the buffer is all whitespace", () => {
    expect(skipWordLeft("   ", 3)).toBe(0);
  });
});

describe("skipWordRight", () => {
  test("from the start, lands at the start of the next word", () => {
    expect(skipWordRight("hello world foo", 0)).toBe(6);
  });

  test("from mid-word, lands at the start of the next word", () => {
    expect(skipWordRight("hello world foo", 3)).toBe(6);
  });

  test("from whitespace, lands at the start of the next word", () => {
    expect(skipWordRight("hello  world", 6)).toBe(7);
  });

  test("skips across a newline to the next line's first word", () => {
    expect(skipWordRight("hello\nworld", 0)).toBe(6);
  });

  test("stays at the end when already at the end", () => {
    expect(skipWordRight("hello world", 11)).toBe(11);
  });

  test("stays at the end after the last word", () => {
    expect(skipWordRight("hello world ", 11)).toBe(12);
  });

  test("empty buffer stays at 0", () => {
    expect(skipWordRight("", 0)).toBe(0);
  });
});
