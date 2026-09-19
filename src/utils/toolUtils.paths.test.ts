import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { normalizePathInputs, resolvePath } from "./toolUtils.js";

const WD = "/Users/liang/deepseek-code";

describe("resolvePath expands and normalizes", () => {
  test("relative paths resolve against the working dir", () => {
    expect(resolvePath(WD, "src/a.ts")).toBe("/Users/liang/deepseek-code/src/a.ts");
  });

  test("`..` collapses", () => {
    expect(resolvePath(WD, "../other/a.ts")).toBe("/Users/liang/other/a.ts");
    expect(resolvePath(WD, "src/../../up.ts")).toBe("/Users/liang/up.ts");
  });

  test("`~` expands to the home directory", () => {
    // Before this, `~/x` resolved to `<cwd>/~/x` — a path that never exists.
    expect(resolvePath(WD, "~/notes.md")).toBe(`${homedir()}/notes.md`);
    expect(resolvePath(WD, "~")).toBe(homedir());
  });

  test("`~` is only special at the start of the path", () => {
    expect(resolvePath(WD, "src/~weird.ts")).toBe("/Users/liang/deepseek-code/src/~weird.ts");
    expect(resolvePath(WD, "a~b.ts")).toBe("/Users/liang/deepseek-code/a~b.ts");
  });

  test("an absolute path is normalized, not returned verbatim", () => {
    expect(resolvePath(WD, "/etc/../etc/passwd")).toBe("/etc/passwd");
  });

  test("a missing path yields the working dir", () => {
    expect(resolvePath(WD, undefined)).toBe(WD);
    expect(resolvePath(WD, "")).toBe(WD);
  });
});

describe("normalizePathInputs gives hooks the real file", () => {
  test("the `..` form of a path is resolved to what it names", () => {
    const observed = normalizePathInputs(WD, { file_path: "../../../Users/liang/.ssh/id_rsa" });
    expect(observed.file_path).toBe("/Users/liang/.ssh/id_rsa");
  });

  test("the `~` form of a path is resolved to what it names", () => {
    const observed = normalizePathInputs(WD, { file_path: "~/.ssh/id_rsa" });
    expect(observed.file_path).toBe(`${homedir()}/.ssh/id_rsa`);
  });

  test("every path-valued key is covered, patterns are not", () => {
    const observed = normalizePathInputs(WD, {
      file_path: "../a.ts",
      path: "../b.ts",
      notebook_path: "../c.ipynb",
      filePath: "../d.ts",
      pattern: "../e.ts",
      command: "cat ../f.ts",
    });
    expect(observed).toEqual({
      file_path: "/Users/liang/a.ts",
      path: "/Users/liang/b.ts",
      notebook_path: "/Users/liang/c.ipynb",
      filePath: "/Users/liang/d.ts",
      // Not a path: a glob pattern and a shell command stay as written.
      pattern: "../e.ts",
      command: "cat ../f.ts",
    });
  });

  test("input with no path field is returned untouched", () => {
    const input = { command: "ls" };
    expect(normalizePathInputs(WD, input)).toBe(input);
  });

  test("the caller's input object is never mutated", () => {
    // tool.call() still receives the original, so it must be intact.
    const input = { file_path: "../a.ts" };
    normalizePathInputs(WD, input);
    expect(input.file_path).toBe("../a.ts");
  });
});
