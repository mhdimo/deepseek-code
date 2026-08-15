import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { extractCodeBlocks, fileExtension, truncateLine } from "./CopyPicker.js";

describe("extractCodeBlocks", () => {
  test("pulls fenced blocks with language and code", () => {
    const markdown = "Intro\n\n```ts\nconst x = 1;\n```\n\nOutro\n\n```python\nprint(1)\n```";
    expect(extractCodeBlocks(markdown)).toEqual([
      { code: "const x = 1;", lang: "ts" },
      { code: "print(1)", lang: "python" },
    ]);
  });

  test("handles missing language, blank fences, and no fences", () => {
    expect(extractCodeBlocks("```\nplain\n```")).toEqual([{ code: "plain", lang: undefined }]);
    expect(extractCodeBlocks("```js\n```")).toEqual([{ code: "", lang: "js" }]);
    expect(extractCodeBlocks("no fences here")).toEqual([]);
  });

  test("strips the trailing newline of a block", () => {
    expect(extractCodeBlocks("```txt\nline1\nline2\n```")[0]?.code).toBe("line1\nline2");
  });
});

describe("fileExtension", () => {
  test("sanitizes language identifiers", () => {
    expect(fileExtension("tsx")).toBe(".tsx");
    expect(fileExtension("python")).toBe(".python");
    // Non-alphanumerics are stripped to prevent path traversal.
    expect(fileExtension("../../etc/passwd")).toBe(".etcpasswd");
  });

  test("falls back to .txt for plaintext or missing", () => {
    expect(fileExtension(undefined)).toBe(".txt");
    expect(fileExtension("plaintext")).toBe(".txt");
    expect(fileExtension("")).toBe(".txt");
  });
});

describe("truncateLine", () => {
  test("keeps short first lines", () => {
    expect(truncateLine("short", 60)).toBe("short");
  });

  test("truncates wide lines to maxLen display columns with an ellipsis", () => {
    const result = truncateLine("a".repeat(80), 60);
    expect(stringWidth(result)).toBe(60);
    expect(result.endsWith("…")).toBe(true);
  });

  test("measures wide characters as two columns", () => {
    const result = truncateLine("界".repeat(40), 60);
    expect(stringWidth(result)).toBeLessThanOrEqual(60);
    expect(result.endsWith("…")).toBe(true);
  });
});
