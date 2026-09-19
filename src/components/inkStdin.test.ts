/**
 * What reaches ink's keypress parser.
 *
 * ink 6.8 does not survive every byte a terminal can hand it. `parseKeypress`
 * reads a CSI's parameters as a modifier bitflag, and for a sequence it has no
 * key for — any SGR, `ESC[31m` above all, which is what a paste out of a
 * coloured terminal is made of — it lands on `ctrl: true` with `name`
 * undefined. Ink then calls `undefined.startsWith` and the process dies inside
 * the input handler, before any `useInput` callback could guard against it.
 *
 * So the app filters stdin (index.tsx) and hands ink the result. These tests
 * pin the filter: what it drops, what it must never drop, and the fact that the
 * app still installs it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_PENDING, StdinSanitizer, isInputSequence } from "./inkStdin.js";

describe("the stdin filter", () => {
  const sanitize = (chunk: string) => new StdinSanitizer().push(chunk);

  test("colour codes never reach ink's parser", () => {
    // `ESC[31m` is the one that kills the process rather than a character: ink
    // reads `31 & 4` as ctrl, looks `[m` up in its key table, gets undefined,
    // and calls `undefined.startsWith`. Every SGR sequence does this — and the
    // short ones (`ESC[0m`) with a different parameter, because any value with
    // bit 3 set leaves ctrl true.
    expect(sanitize("\x1b[31m")).toBe("");
    expect(sanitize("\x1b[0m")).toBe("");
    expect(sanitize("\x1b[1;32m")).toBe("");
    expect(sanitize("\x1b[38;5;196m")).toBe("");
    expect(sanitize("a\x1b[31mred\x1b[0m word")).toBe("ared word");
  });

  test("terminal plumbing goes too", () => {
    // None of this is typing: device replies, window titles, hyperlinks. Left
    // in, they are what gets inserted into the prompt.
    for (const plumbing of [
      "\x1b[6n",
      "\x1b[12;34R",
      "\x1b[?62;c",
      "\x1b[2J",
      "\x1b[1G",
      "\x1b]0;my title\x07",
      "\x1b]8;;http://example.com\x07",
      "\x1b[?25l",
    ]) {
      expect(sanitize(plumbing)).toBe("");
    }
  });

  test("every key ink does have keeps working", () => {
    for (const key of [
      "\x1b[A", // up
      "\x1b[B", // down
      "\x1b[C", // right
      "\x1b[D", // left
      "\x1b[H", // home
      "\x1b[F", // end
      "\x1b[Z", // shift+tab
      "\x1b[1;5D", // ctrl+left
      "\x1b[1;3C", // alt+right
      "\x1b[3~", // delete
      "\x1b[5~", // page up
      "\x1b[11~", // f1
      "\x1b[24~", // f12
      "\x1b[<64;10;15M", // wheel up
      "\x1b[<65;10;15M", // wheel down
      "\x1b[200~", // paste start
      "\x1b[201~", // paste end
      "\x1bOA", // ss3 up
      "\x1bOP", // ss3 f1
      "\x1bq", // ESC + char: alt/option chord
      "plain text",
      "café 👍",
    ]) {
      expect(sanitize(key)).toBe(key);
    }
  });

  test("a sequence split across reads is held and rejoined", () => {
    const filter = new StdinSanitizer();
    expect(filter.push("hel\x1b[3")).toBe("hel");
    expect(filter.push("1m")).toBe("");
    expect(filter.push("lo\x1b[<64")).toBe("lo");
    expect(filter.push(";10;15M")).toBe("\x1b[<64;10;15M");
  });

  test("an escape key is handed on as ink would resolve it, not swallowed", () => {
    const filter = new StdinSanitizer();
    expect(filter.push("\x1b")).toBe("");
    expect(filter.push("a")).toBe("\x1ba");
  });

  test("an unterminated escape sequence cannot swallow the session", () => {
    // A clipboard that cut an OSC short would otherwise hold every later
    // keystroke hostage while the filter waited for an end that never comes.
    const filter = new StdinSanitizer();
    filter.push("\x1b]8;;http://example.com/truncated");
    expect(filter.push("x".repeat(MAX_PENDING))).toBe("");
    expect(filter.push("still typing")).toBe("still typing");
  });

  test("the allowlist is a decision, not a shape", () => {
    expect(isInputSequence("\x1b[A")).toBe(true);
    expect(isInputSequence("\x1b[31m")).toBe(false);
    // Both are digits followed by one letter — only the key table separates
    // them, which is why this reads a table and not a regex.
    expect(isInputSequence("\x1b[1;5D")).toBe(true);
    expect(isInputSequence("\x1b[1;5u")).toBe(false);
  });
});

describe("the app installs the filter", () => {
  const index = readFileSync(join(import.meta.dir, "../index.tsx"), "utf-8");

  test("ink is handed the filtered stdin, not the process's own", () => {
    // Without this the filter is dead code and the crash is back.
    expect(index).toContain("createSanitizedStdin(process.stdin)");
    expect(index).toContain("...INK_RENDER_OPTIONS");
  });
});
