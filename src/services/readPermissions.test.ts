/**
 * The read/search half of the permission surface: which reads leave the
 * working directory, and what happens when one does.
 *
 * The prompt is the only thing standing between a read and the rest of the
 * disk, so these tests pin it from both sides — the paths that must not reach
 * it (everything inside the project, plan mode, tools that name no path) and
 * the ones that must.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkReadAccess,
  isOutsideWorkingDir,
  readTargetPath,
} from "./readPermissions.js";

const root = mkdtempSync(join(tmpdir(), "readperm-"));
const project = join(root, "project");
const sibling = join(root, "sibling");
mkdirSync(join(project, "src"), { recursive: true });
mkdirSync(sibling, { recursive: true });
writeFileSync(join(project, "src", "a.ts"), "x");
writeFileSync(join(sibling, "secret.txt"), "y");

/** A symlink that lives in the project and points out of it: the spelling is
 *  inside, the bytes are not. */
symlinkSync(join(sibling, "secret.txt"), join(project, "escape.txt"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function context(overrides: Partial<Parameters<typeof checkReadAccess>[2]> = {}) {
  const asked: Array<{ toolName: string; description: string; input?: unknown }> = [];
  const ctx = {
    workingDir: project,
    getPlanMode: () => false,
    requestPermission: async (
      toolName: string,
      description: string | (() => string),
      input?: unknown,
    ) => {
      asked.push({
        toolName,
        description: typeof description === "function" ? description() : description,
        input,
      });
      return { approved: true };
    },
    ...overrides,
  };
  return { ctx, asked };
}

describe("readTargetPath", () => {
  test("resolves the field each read tool searches from", () => {
    expect(readTargetPath("Read", { file_path: "src/a.ts" }, project)).toBe(
      join(project, "src", "a.ts"),
    );
    expect(readTargetPath("Grep", { pattern: "x", path: "src" }, project)).toBe(
      join(project, "src"),
    );
    expect(readTargetPath("Glob", { pattern: "**/*.ts", path: "../sibling" }, project)).toBe(
      sibling,
    );
  });

  test("expands ~ so the check sees the file the tool will open", () => {
    const home = process.env.HOME ?? "";
    expect(readTargetPath("Read", { file_path: "~/notes.txt" }, project)).toBe(
      join(home, "notes.txt"),
    );
  });

  test("a tool that names no path has nothing outside the directory", () => {
    // Glob/Grep default to the working directory, and every other tool is not
    // this guard's business.
    expect(readTargetPath("Glob", { pattern: "**/*.ts" }, project)).toBeNull();
    expect(readTargetPath("Grep", {}, project)).toBeNull();
    expect(readTargetPath("Bash", { command: "cat /etc/hosts" }, project)).toBeNull();
  });
});

describe("isOutsideWorkingDir", () => {
  test("paths under the working directory stay inside", () => {
    expect(isOutsideWorkingDir(join(project, "src", "a.ts"), project)).toBe(false);
    expect(isOutsideWorkingDir(project, project)).toBe(false);
  });

  test("a path that does not exist yet is judged by its name", () => {
    expect(isOutsideWorkingDir(join(project, "src", "new.ts"), project)).toBe(false);
    expect(isOutsideWorkingDir(join(sibling, "new.txt"), project)).toBe(true);
  });

  test("siblings, parents and traversal are outside", () => {
    expect(isOutsideWorkingDir(join(sibling, "secret.txt"), project)).toBe(true);
    expect(isOutsideWorkingDir(root, project)).toBe(true);
    // `..` is resolved before the comparison, so it cannot be used to leave.
    expect(isOutsideWorkingDir(join(project, "..", "sibling", "secret.txt"), project)).toBe(true);
  });

  test("a symlink out of the project is outside, however it is spelled", () => {
    // Inside by name, outside by target: approving this in the project's name
    // would approve reading the sibling's file.
    expect(isOutsideWorkingDir(join(project, "escape.txt"), project)).toBe(true);
  });
});

describe("checkReadAccess", () => {
  test("a read inside the working directory never asks", async () => {
    const { ctx, asked } = context();
    expect(await checkReadAccess("Read", { file_path: "src/a.ts" }, ctx)).toEqual({
      approved: true,
    });
    expect(asked).toHaveLength(0);
  });

  test("a read outside the working directory asks, naming the tool and the file", async () => {
    const { ctx, asked } = context();
    const input = { file_path: join(sibling, "secret.txt") };
    expect(await checkReadAccess("Read", input, ctx)).toEqual({ approved: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.toolName).toBe("Read");
    expect(asked[0]!.description.split("\n")[0]).toBe(join(sibling, "secret.txt"));
    expect(asked[0]!.description).toContain("Outside the working directory");
    expect(asked[0]!.input).toBe(input);
  });

  test("the answer is the decision — a refusal must not be overridden", async () => {
    const { ctx } = context({
      requestPermission: async () => ({ approved: false, feedback: "not this time" }),
    });
    expect(
      await checkReadAccess("Grep", { pattern: "key", path: sibling }, ctx),
    ).toEqual({ approved: false, feedback: "not this time" });
  });

  test("searches ask the same way reads do", async () => {
    for (const toolName of ["Glob", "Grep"]) {
      const { ctx, asked } = context();
      await checkReadAccess(toolName, { pattern: "x", path: sibling }, ctx);
      expect(asked.map((a) => a.toolName)).toEqual([toolName]);
    }
  });

  test("plan mode reads freely — it is read-only, and the UI refuses every request", async () => {
    // The prompt is not reachable in plan mode: App's requestPermission returns
    // "Plan mode is read-only" before it renders one. Asking would deny an
    // exploration, so the check stands down instead.
    const { ctx, asked } = context({ getPlanMode: () => true });
    expect(await checkReadAccess("Read", { file_path: join(sibling, "secret.txt") }, ctx)).toEqual({
      approved: true,
    });
    expect(asked).toHaveLength(0);
  });

  test("tools this guard does not govern are untouched", async () => {
    const { ctx, asked } = context();
    expect(await checkReadAccess("Bash", { command: "cat /etc/hosts" }, ctx)).toEqual({
      approved: true,
    });
    expect(await checkReadAccess("Write", { file_path: "/tmp/x" }, ctx)).toEqual({
      approved: true,
    });
    expect(asked).toHaveLength(0);
  });
});
