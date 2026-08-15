import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  estimateSkillTokens,
  getSkillSourceDir,
  parseSkillMarkdown,
} from "./skillService.js";

describe("parseSkillMarkdown", () => {
  test("extracts when_to_use frontmatter alongside name and description", () => {
    const parsed = parseSkillMarkdown(
      [
        "---",
        "name: git-commit",
        "description: Write conventional commit messages",
        "when_to_use: When the user asks for a commit",
        "---",
        "",
        "# Body",
      ].join("\n"),
    );
    expect(parsed.name).toBe("git-commit");
    expect(parsed.description).toBe("Write conventional commit messages");
    expect(parsed.whenToUse).toBe("When the user asks for a commit");
    expect(parsed.body).toBe("# Body");
  });

  test("missing frontmatter yields no whenToUse", () => {
    const parsed = parseSkillMarkdown("plain body without frontmatter");
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.whenToUse).toBeUndefined();
    expect(parsed.body).toBe("plain body without frontmatter");
  });
});

describe("estimateSkillTokens", () => {
  test("uses ~4 chars per token over name + description + whenToUse", () => {
    // 4 chars -> 1 token
    expect(estimateSkillTokens("abcd", undefined, undefined)).toBe(1);
    // 20+1+20+1+20 = 62 chars -> ceil(62/4) = 16
    expect(estimateSkillTokens("a".repeat(20), "b".repeat(20), "c".repeat(20))).toBe(16);
  });

  test("skips missing fields", () => {
    // "abc d" = 5 chars -> ceil(5/4) = 2
    expect(estimateSkillTokens("abc", undefined, "d")).toBe(2);
  });
});

describe("getSkillSourceDir", () => {
  test("project dir is cwd-relative .claude/skills", () => {
    expect(getSkillSourceDir("project")).toBe(join(".claude", "skills"));
  });

  test("user dir is under the home directory", () => {
    expect(getSkillSourceDir("user")).toBe(join(homedir(), ".claude", "skills"));
  });

  test("plugin has no on-disk dir", () => {
    expect(getSkillSourceDir("plugin")).toBe("plugin");
  });
});
