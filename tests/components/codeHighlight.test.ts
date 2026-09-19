import { describe, expect, test } from "bun:test";
import { highlightLine, languageFromPath } from "../../src/components/codeHighlight.js";
import {
  GITHUB_SCOPES,
  MONOKAI_SCOPES,
  getTheme,
  syncLiveTheme,
  theme as liveTheme,
} from "../../src/utils/theme.js";

const dark = getTheme("dark");

// The scope tables are the reference's (native-ts/color-diff/index.ts):
// Monokai Extended on dark, GitHub on light, and the bright half of the
// 16-colour palette on the ansi variants. The theme names its family; the
// highlighter owns the colours.
describe("theme syntax scopes", () => {
  test("each theme names the scope table its highlighting draws from", () => {
    expect(getTheme("dark").syntaxScopes).toBe("monokai");
    expect(getTheme("light").syntaxScopes).toBe("github");
    expect(getTheme("dark-ansi").syntaxScopes).toBe("ansi");
    // The daltonized palettes spread their base, so they inherit its family.
    expect(getTheme("dark-daltonized").syntaxScopes).toBe("monokai");
    expect(getTheme("light-daltonized").syntaxScopes).toBe("github");
    expect(getTheme("light-ansi").syntaxScopes).toBe("ansi");
  });

  // Markdown's code blocks highlight through the mutable theme object rather
  // than a context, so the family has to survive syncLiveTheme's per-key copy.
  test("the mutable theme keeps the family in step with the mode", () => {
    try {
      syncLiveTheme("light");
      expect(liveTheme.syntaxScopes).toBe("github");
      syncLiveTheme("dark");
      expect(liveTheme.syntaxScopes).toBe("monokai");
    } finally {
      syncLiveTheme("dark");
    }
  });
});

describe("highlightLine", () => {
  test("a line is tokenized by highlight.js and coloured from the theme's scope table", () => {
    const spans = highlightLine("const x = 1;", "typescript", dark);
    expect(spans.map((s) => s.text).join("")).toBe("const x = 1;");
    expect(spans.find((s) => s.text === "const")?.color).toBe(MONOKAI_SCOPES["_storage"]);
    expect(spans.find((s) => s.text === "1")?.color).toBe(MONOKAI_SCOPES["number"]);
  });

  test("a library type is its own token, not just another word", () => {
    const spans = highlightLine('const b = new Promise<Record<string, number>>("x");', "typescript", dark);
    expect(spans.find((s) => s.text === "Promise")?.color).toBe(MONOKAI_SCOPES["title.class"]);
    expect(spans.find((s) => s.text === "Record")?.color).toBe(MONOKAI_SCOPES["title.class"]);
    expect(spans.find((s) => s.text === '"x"')?.color).toBe(MONOKAI_SCOPES["string"]);
  });

  test("each language is highlighted by its own grammar", () => {
    const spans = highlightLine("def f(x): return x  # hi", "python", dark);
    expect(spans.find((s) => s.text === "def")?.color).toBe(MONOKAI_SCOPES["_storage"]);
    expect(spans.find((s) => s.text === "f")?.color).toBe(MONOKAI_SCOPES["title.function"]);
    expect(spans.find((s) => s.text === "# hi")?.color).toBe(MONOKAI_SCOPES["comment"]);
  });

  test("the light theme draws from its own table", () => {
    const spans = highlightLine("const x = 1;", "typescript", getTheme("light"));
    expect(spans.find((s) => s.text === "const")?.color).toBe(GITHUB_SCOPES["_storage"]);
  });

  test("a line with no language, or one with no grammar, comes back whole and uncoloured", () => {
    expect(highlightLine("const x = 1;", "", dark)).toEqual([{ text: "const x = 1;" }]);
    expect(highlightLine("const x = 1;", "notalanguage", dark)).toEqual([{ text: "const x = 1;" }]);
  });

  // Anything written to the console lands in the middle of the TUI's render.
  test("an unknown language is not announced on the console", () => {
    const written: unknown[][] = [];
    const methods = ["log", "warn", "error"] as const;
    const originals = methods.map((name) => [name, console[name]] as const);
    for (const name of methods) {
      console[name] = (...args: unknown[]) => {
        written.push(args);
      };
    }
    try {
      highlightLine("const x = 1;", "notalanguage", dark);
    } finally {
      for (const [name, original] of originals) console[name] = original;
    }
    expect(written).toEqual([]);
  });

  // The diff slices these spans and the word-level bands against each other by
  // character offset, so a span set that does not reconstruct the line exactly
  // would shear the diff.
  test("the spans always reconstruct the line exactly", () => {
    const lines: [string, string][] = [
      ["const b = new Promise<Record<string, number>>(\"x\");", "ts"],
      ["def f(x): return x  # hi", "py"],
      ["", "ts"],
      ["  // trailing comment never terminates", "ts"],
      ["SELECT id, name FROM users -- comment", "sql"],
    ];
    for (const [line, lang] of lines) {
      expect(highlightLine(line, lang, dark).map((s) => s.text).join("")).toBe(line);
    }
  });
});

describe("languageFromPath", () => {
  test("names a grammar from the file name, its extension, or the shebang", () => {
    expect(languageFromPath("/a/b/Makefile")).toBe("makefile");
    expect(languageFromPath("src/app.ts")).toBe("ts");
    expect(languageFromPath("script.py")).toBe("py");
    // Nothing registered for the extension, so nothing to highlight with.
    expect(languageFromPath("notes.unknownext")).toBe("");
    expect(languageFromPath("run", "#!/usr/bin/env python3")).toBe("python");
  });
});
