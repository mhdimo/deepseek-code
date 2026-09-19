/**
 * End-to-end tests for the Glob tool's `call`, over a real directory tree.
 *
 * The matcher is unit-tested in glob.test.ts; these exist because the defect
 * being fixed was not in a matcher — the tool advertised `**` patterns while
 * delegating to `find -name`, which cannot match them at all. A correct matcher
 * that the tool does not call would be the same bug with more code.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GlobTool } from "./GlobTool.js";

let root: string;

function makeFile(relPath: string, mtimeSeconds?: number): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "x");
  if (mtimeSeconds !== undefined) {
    utimesSync(full, mtimeSeconds, mtimeSeconds);
  }
}

async function call(input: { pattern: string; path?: string }): Promise<string> {
  const context = {
    workingDir: root,
    abortController: new AbortController(),
    permissions: { allowRead: true },
  };
  const result = await (GlobTool as never as {
    call: (i: unknown, c: unknown) => Promise<{ data: unknown }>;
  }).call(input, context);
  return String(result.data);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "globtool-"));
  makeFile("a.ts");
  makeFile("src/b.ts");
  makeFile("src/deep/c.ts");
  makeFile("src/App.tsx");
  makeFile("src/ui/Panel.tsx");
  makeFile("other/App.tsx");
  makeFile("notes.md");
  makeFile("node_modules/pkg/index.ts");
  makeFile(".git/objects/aa/bb");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Glob matches the patterns it advertises", () => {
  test("**/*.ts finds files at every depth", async () => {
    const lines = (await call({ pattern: "**/*.ts" })).split("\n").sort();
    expect(lines).toEqual(["a.ts", "src/b.ts", "src/deep/c.ts"]);
  });

  test("src/**/*.tsx finds nested files under the given directory", async () => {
    const lines = (await call({ pattern: "src/**/*.tsx" })).split("\n").sort();
    expect(lines).toEqual(["src/App.tsx", "src/ui/Panel.tsx"]);
  });

  test("a bare *.ts still matches by file name, at any depth", async () => {
    const lines = (await call({ pattern: "*.ts" })).split("\n").sort();
    expect(lines).toEqual(["a.ts", "src/b.ts", "src/deep/c.ts"]);
  });

  test("results are relative to the working directory", async () => {
    const out = await call({ pattern: "**/c.ts" });
    expect(out).toBe("src/deep/c.ts");
  });
});

describe("the walk", () => {
  test("node_modules and .git are not walked", async () => {
    expect(await call({ pattern: "**/*.ts" })).not.toContain("node_modules");
    const git = await call({ pattern: "**/bb" });
    expect(git).toBe("No files matched the pattern.");
  });

  test("an empty match set says so, distinctly from an error", async () => {
    expect(await call({ pattern: "**/*.zig" })).toBe("No files matched the pattern.");
  });

  test("a missing directory is an error, not an empty result", async () => {
    const out = await call({ pattern: "*.ts", path: join(root, "nope") });
    expect(out).toStartWith("Directory does not exist:");
    expect(out).toContain("your current working directory is");
  });

  test("a file in place of a directory is reported as such", async () => {
    const out = await call({ pattern: "*.ts", path: join(root, "a.ts") });
    expect(out).toBe(`Path is not a directory: ${join(root, "a.ts")}`);
  });

  test("an abort stops the walk instead of returning partial results", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await (GlobTool as never as {
      call: (i: unknown, c: unknown) => Promise<{ data: unknown }>;
    }).call({ pattern: "**/*.ts" }, {
      workingDir: root,
      abortController: controller,
      permissions: { allowRead: true },
    });
    expect(String(result.data)).toBe("Aborted/Cancelled by user");
  });
});

describe("result limits", () => {
  test("more than 100 matches are truncated, oldest first, with a note", async () => {
    const bulk = mkdtempSync(join(tmpdir(), "globtool-bulk-"));
    try {
      for (let i = 0; i < 105; i++) {
        const full = join(bulk, `f${String(i).padStart(3, "0")}.txt`);
        writeFileSync(full, "x");
        // Distinct, ascending mtimes: f000 oldest … f104 newest.
        utimesSync(full, 1_600_000_000 + i, 1_600_000_000 + i);
      }
      const result = await (GlobTool as never as {
        call: (i: unknown, c: unknown) => Promise<{ data: unknown }>;
      }).call({ pattern: "*.txt" }, {
        workingDir: bulk,
        abortController: new AbortController(),
        permissions: { allowRead: true },
      });
      const lines = String(result.data).split("\n");
      const note = lines.pop()!;

      expect(lines.length).toBe(100);
      expect(note).toBe(
        "(Results are truncated. Consider using a more specific path or pattern.)",
      );
      // Oldest first, as rg --sort=modified orders the reference's results.
      expect(lines[0]).toBe("f000.txt");
      expect(lines[99]).toBe("f099.txt");
    } finally {
      rmSync(bulk, { recursive: true, force: true });
    }
  });
});
