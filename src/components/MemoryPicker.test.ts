import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMORY_PATH, buildMemoryOptions, isInGitRepo, memoryCandidates } from "./MemoryPicker.js";

function tempWorkingDir(): string {
  return mkdtempSync(join(tmpdir(), "memory-picker-"));
}

describe("memoryCandidates", () => {
  test("lists user memory first, then project files", () => {
    const candidates = memoryCandidates("/tmp/proj");
    expect(candidates.map((c) => c.kind)).toEqual(["user", "project", "project", "project"]);
    expect(candidates[0]?.label).toBe("User memory");
    expect(candidates.map((c) => c.label)).toEqual([
      "User memory",
      "CLAUDE.md (project)",
      "DEEP.md (project)",
      "AGENTS.md (project)",
    ]);
  });
});

describe("buildMemoryOptions", () => {
  test("marks missing files with (new) and orders user memory first", () => {
    const dir = tempWorkingDir();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# hi");
      const options = buildMemoryOptions(dir);
      const userLabel = existsSync(USER_MEMORY_PATH) ? "User memory" : "User memory (new)";
      expect(options[0]?.label).toBe(userLabel);
      expect(options[1]?.label).toBe("CLAUDE.md (project)");
      expect(options[2]?.label).toBe("DEEP.md (project) (new)");
      expect(options[3]?.label).toBe("AGENTS.md (project) (new)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses git-aware descriptions for project CLAUDE.md", () => {
    const dir = tempWorkingDir();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# hi");
      expect(buildMemoryOptions(dir)[1]?.description).toBe("Saved in ./CLAUDE.md");
      mkdirSync(join(dir, ".git"));
      expect(buildMemoryOptions(dir)[1]?.description).toBe("Checked in at ./CLAUDE.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isInGitRepo", () => {
  test("detects a .git directory", () => {
    const dir = tempWorkingDir();
    try {
      expect(isInGitRepo(dir)).toBe(false);
      mkdirSync(join(dir, ".git"));
      expect(isInGitRepo(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
