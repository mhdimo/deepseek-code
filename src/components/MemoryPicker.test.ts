import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { renderToString } from "ink";
import MemoryPicker, { USER_MEMORY_PATH, buildMemoryOptions, isInGitRepo, memoryCandidates } from "./MemoryPicker.js";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

function tempWorkingDir(): string {
  return mkdtempSync(join(tmpdir(), "memory-picker-"));
}

/** The /memory screen as ink lays it out, ANSI stripped. */
function frame(workingDirectory: string): string {
  return renderToString(
    React.createElement(MemoryPicker, {
      workingDirectory,
      onOpenInEditor: () => {},
      onClose: () => {},
    }),
    { columns: 120 },
  ).replace(ANSI, "");
}

describe("memoryCandidates", () => {
  test("lists user memory first, then project files", () => {
    const candidates = memoryCandidates("/tmp/proj");
    expect(candidates.map((c) => c.kind)).toEqual(["user", "project", "project"]);
    expect(candidates[0]?.label).toBe("User memory");
    expect(candidates.map((c) => c.label)).toEqual([
      "User memory",
      "Project memory",
      "AGENTS.md (project)",
    ]);
    // DEEP.md was this app's own name for project memory and no other tool
    // reads it. Offering it here sent the user to a file the model never
    // loaded; AGENTS.md is the name that survives.
    expect(candidates.some((c) => c.path.endsWith("DEEP.md"))).toBe(false);
  });
});

describe("buildMemoryOptions", () => {
  test("names the two built-in rows and reserves (new) for the path rows", () => {
    const dir = tempWorkingDir();
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# hi");
      const options = buildMemoryOptions(dir);
      expect(options[0]?.label).toBe("User memory");
      expect(options[1]?.label).toBe("Project memory");
      expect(options[2]?.label).toBe("AGENTS.md (project) (new)");
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

describe("/memory screen against the reference", () => {
  test("is headed 'Memory' with no subtitle", () => {
    const dir = tempWorkingDir();
    try {
      const out = frame(dir);
      expect(out).toContain("Memory");
      expect(out).not.toContain("Memory files");
      expect(out).not.toContain("Instructions files that steer the agent in this project");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("closes with the docs line, above the dialog's Enter/Esc guide", () => {
    const dir = tempWorkingDir();
    try {
      const out = frame(dir);
      expect(out).toContain("Learn more: https://api-docs.deepseek.com");
      expect(out.indexOf("Learn more:")).toBeLessThan(out.indexOf("Enter to confirm"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("foots the dialog's own guide, not a bespoke key list", () => {
    const dir = tempWorkingDir();
    try {
      const out = frame(dir);
      expect(out).toContain("Enter to confirm · Esc to cancel");
      expect(out).not.toContain("to choose · enter to open");
      expect(out).not.toContain("esc to cancel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
