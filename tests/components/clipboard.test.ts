/**
 * Clipboard reading for right-click paste. The OS call is behind a seam so
 * the TUI tests never spawn a parent process; the default path is pbpaste on
 * macOS (the platform the app ships on), null everywhere else.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { __setClipboardReaderForTests, readClipboardText } from "../../src/components/clipboard.js";

afterEach(() => __setClipboardReaderForTests(null));

describe("readClipboardText", () => {
  test("the test seam is used when set", () => {
    __setClipboardReaderForTests(() => "pasted");
    expect(readClipboardText()).toBe("pasted");
  });

  test("an empty clipboard is null, not an empty string", () => {
    __setClipboardReaderForTests(() => "");
    expect(readClipboardText()).toBe(null);
  });

  test("seam returning null passes through", () => {
    __setClipboardReaderForTests(() => null);
    expect(readClipboardText()).toBe(null);
  });
});
