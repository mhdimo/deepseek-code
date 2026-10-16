import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { formatWorkingDirectory, readGitStatus } from "./gitStatus.js";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-git-status-"));

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): boolean {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return proc.exitCode === 0;
}

describe("readGitStatus", () => {
  test("reports the branch and stays clean until something changes", () => {
    const repo = join(sandbox, "repo");
    mkdirSync(repo, { recursive: true });
    expect(git(repo, "init", "-q", "-b", "trunk")).toBe(true);

    // No commits yet: the porcelain header is the "No commits yet on <name>"
    // spelling, and the branch still has to come out of it.
    expect(readGitStatus(repo)).toEqual({ branch: "trunk", dirty: false });

    writeFileSync(join(repo, "a.txt"), "hello\n");
    expect(readGitStatus(repo)).toEqual({ branch: "trunk", dirty: true });
  });

  test("a stage or a commit does not make it dirty, a worktree edit does", () => {
    const repo = join(sandbox, "repo2");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "a.txt");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    expect(readGitStatus(repo)).toEqual({ branch: "main", dirty: false });

    writeFileSync(join(repo, "a.txt"), "two\n");
    expect(readGitStatus(repo)?.dirty).toBe(true);
  });

  test("a directory that is not a repository answers null", () => {
    const plain = join(sandbox, "plain");
    mkdirSync(plain, { recursive: true });
    expect(readGitStatus(plain)).toBeNull();
  });
});

describe("formatWorkingDirectory", () => {
  test("shortens the home directory and leaves anything else alone", () => {
    expect(formatWorkingDirectory("/home/you/proj", "/home/you")).toBe("~/proj");
    expect(formatWorkingDirectory("/home/you", "/home/you")).toBe("/home/you");
    expect(formatWorkingDirectory("/srv/proj", "/home/you")).toBe("/srv/proj");
    // A sibling whose name merely starts with home is not inside it.
    expect(formatWorkingDirectory("/home/yours/proj", "/home/you")).toBe("/home/yours/proj");
  });
});
