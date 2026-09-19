/**
 * Which files the reading tools are allowed to show.
 *
 * `hasBinaryExtension` is the gate in front of every read. A file whose
 * extension it recognizes never reaches the model at all — FileReadTool
 * answers `Binary file (n bytes, type …) — contents not shown.` and returns
 * before reading a byte. And because an unread file also cannot be *edited*
 * (the read-before-edit guard in services/readState.ts refuses an Edit or a
 * Write to a file the model has not seen), a wrong entry here does not degrade
 * the assistant, it removes a whole language from it.
 *
 * `ts` was on the list, in a block of video-container extensions next to
 * `m2ts`: MPEG transport stream shares the extension with TypeScript, and the
 * port kept the wrong side of that collision. Every `.ts` file in a session
 * became unreadable and uneditable — this repository included, which is how it
 * was found. The reference's own list has no `ts`.
 */

import { describe, expect, test } from "bun:test";

import {
  BINARY_EXTENSIONS,
  getExtension,
  hasBinaryContent,
  hasBinaryExtension,
} from "../../src/constants/files.js";

/** Extensions a coding agent meets constantly. None of these may be gated:
 *  the cost of guessing wrong is a file the model can neither read nor edit,
 *  and it guesses wrong silently. */
const SOURCE_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", // the JS family
  "py", "rb", "go", "rs", "java", "kt", "kts", "cs", "php", "swift", "scala",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "dart", "lua", "r",
  "sh", "bash", "zsh", "fish", "ps1", "pl", "pm", "ex", "exs", "erl", "hs",
  "clj", "cljs", "fs", "ml", "jl", "nim", "zig", "cr", "v", "sv", "vhd",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "xml", "html", "htm", "css", "scss", "sass", "less", "vue", "svelte",
  "md", "markdown", "rst", "txt", "tex", "org", "csv", "tsv", "svg",
  "sql", "graphql", "gql", "proto", "tf", "hcl", "lock", "gitignore",
];

/** Extensions that really are opaque bytes, and must stay gated. */
const REALLY_BINARY_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "ico", "mp4", "mov", "mkv", "mp3",
  "wav", "flac", "zip", "gz", "tar", "xz", "7z", "iso", "pdf", "docx",
  "xlsx", "exe", "dll", "dylib", "so", "wasm", "class", "pyc", "ttf",
  "woff2", "sqlite", "db",
];

describe("a source file is never gated as binary", () => {
  test("every source extension is readable", () => {
    const gated = SOURCE_EXTENSIONS.filter((ext) => hasBinaryExtension(`src/file.${ext}`));
    expect(gated).toEqual([]);
  });

  test("TypeScript specifically — the collision that started this", () => {
    // `ts` is MPEG transport stream *and* the language this app is written in.
    // It was on the list; these are the exact paths from the failure.
    for (const path of [
      "src/components/terminalLayout.ts",
      "src/services/contextManager.ts",
      "src/utils/onboarding.ts",
      "src/components/App.ts",
      "src/types/index.d.ts",
    ]) {
      expect(hasBinaryExtension(path)).toBe(false);
    }
  });

  test("the extension check is case-insensitive, so upper case is not a way in", () => {
    // `getExtension` lowercases; assert the property rather than re-deriving it.
    expect(getExtension("src/FILE.TS")).toBe("ts");
    expect(hasBinaryExtension("src/FILE.TS")).toBe(false);
  });

  test("a path with no extension, or a dotted directory, is not gated", () => {
    expect(hasBinaryExtension("Makefile")).toBe(false);
    expect(hasBinaryExtension("src/v1.2/README")).toBe(false);
    expect(hasBinaryExtension("src/trailing.")).toBe(false);
  });
});

describe("a binary file is still gated", () => {
  test("the opaque extensions stay on the list", () => {
    const missed = REALLY_BINARY_EXTENSIONS.filter((ext) => !hasBinaryExtension(`asset.${ext}`));
    expect(missed).toEqual([]);
  });

  test("the list is the extension list — nothing is gated by omission", () => {
    // Guards the shape of the fix: `ts` must be *removed*, not special-cased
    // somewhere downstream where the next reader would not find it.
    expect(BINARY_EXTENSIONS.has("ts")).toBe(false);
    expect(BINARY_EXTENSIONS.has("tsx")).toBe(false);
  });
});

describe("content is the backstop when the extension says nothing", () => {
  test("a NUL byte in an unknown extension is still binary", () => {
    const withNul = new Uint8Array([0x63, 0x6f, 0x00, 0x64, 0x65]);
    expect(hasBinaryContent(withNul)).toBe(true);
  });

  test("plain text — including non-ASCII text — is not binary", () => {
    // The sniff is a NUL scan, not an ASCII test: a file of emoji and accented
    // identifiers is perfectly readable and must not be caught by it.
    const utf8 = new TextEncoder().encode("const ∴ = \"héllo 🐳\";\n");
    expect(hasBinaryContent(utf8)).toBe(false);
  });

  test("an empty buffer is not binary, and a lone NUL past the scan window is not seen", () => {
    expect(hasBinaryContent(new Uint8Array(0))).toBe(false);
    expect(hasBinaryContent(new Uint8Array([0x20, 0x20, 0x20, 0x20]))).toBe(false);

    // Documented, not endorsed: the scan is bounded for a reason (a huge file
    // must not be read to classify it), and the extension list is what covers
    // the cases the window misses.
    const late = new Uint8Array(16).fill(0x20);
    late[12] = 0;
    expect(hasBinaryContent(late, 8)).toBe(false);
    expect(hasBinaryContent(late, 16)).toBe(true);
  });

  test("a .ts file that really is a byte stream is still caught by its content", () => {
    // Removing the extension is safe because the content sniff is the real
    // gate: a transport stream has NULs in its first packets.
    const transportStream = new Uint8Array(188);
    transportStream[0] = 0x47;
    transportStream[100] = 0x00;
    expect(hasBinaryExtension("stream.ts")).toBe(false);
    expect(hasBinaryContent(transportStream)).toBe(true);
  });
});
