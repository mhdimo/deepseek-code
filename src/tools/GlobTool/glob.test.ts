import { describe, expect, test } from "bun:test";
import { matchGlob } from "./glob.js";

/**
 * The expected values here are ripgrep's, produced with `rg --files -g <pat>`
 * over the same tree — the reference implementation delegates to `rg --glob`,
 * so these are the semantics the tool's advertised patterns assume.
 */
describe("matchGlob matches what ripgrep's --glob matches", () => {
  test("a pattern with no separator matches the file name at any depth", () => {
    expect(matchGlob("*.txt", "oldest.txt")).toBe(true);
    expect(matchGlob("*.txt", "sub/deep.txt")).toBe(true);
    expect(matchGlob("*.txt", "a/b/c/deep.txt")).toBe(true);
    expect(matchGlob("*.txt", "deep.md")).toBe(false);
    // Anchored: a partial name is not a match.
    expect(matchGlob("oldest.txt", "the-oldest.txt")).toBe(false);
  });

  test("a pattern with a separator matches the whole relative path", () => {
    expect(matchGlob("sub/*.txt", "sub/deep.txt")).toBe(true);
    expect(matchGlob("sub/*.txt", "other/deep.txt")).toBe(false);
    // `*` stays inside one segment.
    expect(matchGlob("sub/*.txt", "sub/nested/deep.txt")).toBe(false);
  });

  test("** crosses separators — the patterns the tool advertises", () => {
    // The exact regression: these are the examples in the schema description
    // and prompt, and `find -name` could never match either.
    expect(matchGlob("**/*.ts", "a.ts")).toBe(true);
    expect(matchGlob("**/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("**/*.ts", "src/deep/nested/a.ts")).toBe(true);
    expect(matchGlob("src/**/*.tsx", "src/App.tsx")).toBe(true);
    expect(matchGlob("src/**/*.tsx", "src/ui/App.tsx")).toBe(true);
    expect(matchGlob("src/**/*.tsx", "other/App.tsx")).toBe(false);
  });

  test("`**/` also matches zero directories", () => {
    expect(matchGlob("**/deep.txt", "deep.txt")).toBe(true);
    expect(matchGlob("**/deep.txt", "sub/deep.txt")).toBe(true);
  });

  test("trailing ** matches everything under a directory", () => {
    expect(matchGlob("sub/**", "sub/deep.txt")).toBe(true);
    expect(matchGlob("sub/**", "sub/a/b.txt")).toBe(true);
    expect(matchGlob("sub/**", "other/deep.txt")).toBe(false);
  });

  test("a bare ** within a segment still crosses", () => {
    expect(matchGlob("**.txt", "sub/deep.txt")).toBe(true);
  });

  test("? matches one character and does not cross a separator", () => {
    expect(matchGlob("*.t?t", "middle.txt")).toBe(true);
    expect(matchGlob("a?c.txt", "abc.txt")).toBe(true);
    expect(matchGlob("a?c.txt", "ac.txt")).toBe(false);
  });

  test("character classes, including ripgrep's [!...] negation", () => {
    expect(matchGlob("[mn]*.txt", "middle.txt")).toBe(true);
    expect(matchGlob("[mn]*.txt", "newest.txt")).toBe(true);
    expect(matchGlob("[mn]*.txt", "oldest.txt")).toBe(false);
    expect(matchGlob("[!mn]*.txt", "oldest.txt")).toBe(true);
    expect(matchGlob("[!mn]*.txt", "middle.txt")).toBe(false);
  });

  test("brace alternatives", () => {
    expect(matchGlob("{oldest,middle}.txt", "middle.txt")).toBe(true);
    expect(matchGlob("{oldest,middle}.txt", "newest.txt")).toBe(false);
    expect(matchGlob("src/*.{ts,tsx}", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.{ts,tsx}", "src/a.tsx")).toBe(true);
    expect(matchGlob("src/*.{ts,tsx}", "src/a.js")).toBe(false);
  });

  test("a leading ./ is ignored", () => {
    expect(matchGlob("./src/*.ts", "src/a.ts")).toBe(true);
  });

  test("matching is case-sensitive, as ripgrep's is by default", () => {
    expect(matchGlob("*.TXT", "deep.txt")).toBe(false);
  });

  test("regex metacharacters in a pattern are literals, not regex", () => {
    expect(matchGlob("a+b.txt", "a+b.txt")).toBe(true);
    expect(matchGlob("a+b.txt", "aab.txt")).toBe(false);
    expect(matchGlob("a.b.txt", "axb.txt")).toBe(false);
    expect(matchGlob("package.json", "package.json")).toBe(true);
  });
});
