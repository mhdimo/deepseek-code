/**
 * Memory files are the user's instructions to the agent, so the failure that
 * matters is a file they wrote not reaching the model — silently, with the UI
 * still claiming it is in context.
 *
 * These cases are about the two halves of that: which files are even looked
 * for, and what happens to the ones that are found.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMemoryFiles,
  memoryFileCandidates,
  readMemoryFile,
  type MemoryFileCandidate,
} from "./memoryFiles.js";

function sandbox<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "memfiles-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("memoryFileCandidates", () => {
  test("looks for the file names the rest of the ecosystem writes", () => {
    const home = "/home/u";
    const cwd = "/repo/proj";
    const paths = memoryFileCandidates(cwd, home).map((c) => c.path);
    expect(paths).toEqual([
      join(home, ".claude", "CLAUDE.md"),
      join(home, ".claude", "CLAUDE.local.md"),
      join(home, ".deepseek-code", "CLAUDE.md"),
      join(cwd, ".claude", "CLAUDE.md"),
      join(cwd, ".claude", "CLAUDE.local.md"),
      join(cwd, "CLAUDE.md"),
      join(cwd, "AGENTS.md"),
    ]);
  });

  test("never looks for DEEP.md", () => {
    // The app's own invented name. Nothing else opens it, so instructions
    // written there were invisible to every other tool the user runs.
    expect(memoryFileCandidates("/repo", "/home/u").some((c) => c.path.endsWith("DEEP.md"))).toBe(
      false,
    );
  });

  test("reads user memory before project memory", () => {
    // Order is precedence: a project instruction that contradicts a user-level
    // one has to come later in the prompt to win.
    const paths = memoryFileCandidates("/repo", "/home/u").map((c) => c.path);
    // Every user-level file before every project-level one...
    expect(paths.indexOf(join("/home/u", ".claude", "CLAUDE.md"))).toBeLessThan(
      paths.indexOf(join("/repo", "CLAUDE.md")),
    );
    // ...and among the project files, the canonical root CLAUDE.md last, so it
    // settles a contradiction against the .claude/ alternative rather than
    // losing to it.
    expect(paths.indexOf(join("/repo", ".claude", "CLAUDE.md"))).toBeLessThan(
      paths.indexOf(join("/repo", "CLAUDE.md")),
    );
  });

  test("every candidate is labelled distinctly, and by name rather than path", () => {
    const labels = memoryFileCandidates("/repo", "/home/u").map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    // The label is the section header the model sees. It has to say which
    // file this is without being a path the model might try to read.
    for (const label of labels) {
      expect(label.startsWith("/")).toBe(false);
      expect(label).not.toContain("/repo");
    }
  });
});

describe("appendMemoryFiles", () => {
  const files: MemoryFileCandidate[] = [
    { path: "/a", label: "user memory" },
    { path: "/b", label: "project context" },
  ];

  test("appends a labelled section per file", () => {
    const out = appendMemoryFiles("BASE", files, (p) => (p === "/a" ? "A" : "B"));
    expect(out).toBe("BASE\n\n--- user memory ---\nA\n\n--- project context ---\nB");
  });

  test("skips missing and blank files", () => {
    const out = appendMemoryFiles("BASE", files, (p) => (p === "/a" ? "   \n" : null));
    expect(out).toBe("BASE");
  });

  test("appends identical content once, under the higher-precedence name", () => {
    // CLAUDE.md and AGENTS.md are frequently symlinked to one another. Sending
    // the same text twice reads as emphasis the user never gave, and it is
    // billed on every request of the session.
    const out = appendMemoryFiles("BASE", files, () => "SAME");
    expect(out.split("SAME").length - 1).toBe(1);
    // The label tells the model which file it is reading, and a model updating
    // project memory updates the file it was shown. Naming the lower-precedence
    // copy splits it from the canonical one.
    expect(out).toContain("--- project context ---");
    expect(out).not.toContain("--- user memory ---");
  });

  test("an identical pair still keeps the file that has precedence", () => {
    const out = appendMemoryFiles(
      "BASE",
      [
        { path: "/repo/.claude/CLAUDE.md", label: "project context (.claude)" },
        { path: "/repo/CLAUDE.md", label: "project context" },
      ],
      () => "# identical\n",
    );
    expect(out).toContain("--- project context ---");
    expect(out).not.toContain(".claude");
  });

  test("a superseded duplicate does not count as the surviving copy", () => {
    // CLAUDE.md and AGENTS.md byte-identical: AGENTS.md is already skipped, so
    // nothing may treat it as the better name and skip CLAUDE.md too.
    sandbox((dir) => {
      writeFileSync(join(dir, "CLAUDE.md"), "# one document\n");
      writeFileSync(join(dir, "AGENTS.md"), "# one document\n");
      const out = appendMemoryFiles("BASE", memoryFileCandidates(dir, join(dir, "home")), readMemoryFile);
      expect(out.split("# one document").length - 1).toBe(1);
      expect(out).toContain("--- project context ---");
    });
  });

  test("leaves the instructions untouched when nothing is found", () => {
    expect(appendMemoryFiles("BASE", files, () => null)).toBe("BASE");
    expect(appendMemoryFiles("BASE", [], () => "X")).toBe("BASE");
  });

  test("reads real files, and ignores ones that are not there", () => {
    sandbox((dir) => {
      writeFileSync(join(dir, "AGENTS.md"), "# agents\n");
      const candidates = [
        { path: join(dir, "CLAUDE.md"), label: "project context" },
        { path: join(dir, "AGENTS.md"), label: "project context (AGENTS.md)" },
      ];
      const out = appendMemoryFiles("BASE", candidates, readMemoryFile);
      expect(out).toContain("--- project context (AGENTS.md) ---\n# agents");
      expect(out).not.toContain("--- project context ---");
    });
  });

  test("a symlinked duplicate is not paid for twice", () => {
    sandbox((dir) => {
      writeFileSync(join(dir, "CLAUDE.md"), "# one file\n");
      symlinkSync(join(dir, "CLAUDE.md"), join(dir, "AGENTS.md"));
      const out = appendMemoryFiles(
        "BASE",
        [
          { path: join(dir, "CLAUDE.md"), label: "project context" },
          { path: join(dir, "AGENTS.md"), label: "project context (AGENTS.md)" },
        ],
        readMemoryFile,
      );
      expect(out.split("# one file").length - 1).toBe(1);
    });
  });

  test("AGENTS.md is skipped when the same directory has a CLAUDE.md", () => {
    // The two names are one document. A repo moving between them keeps both
    // for a while and the copies drift; reading both then hands the model two
    // versions, and — since this list is ordered by precedence — the stale one
    // is the one that wins.
    sandbox((dir) => {
      writeFileSync(join(dir, "CLAUDE.md"), "# current\n");
      writeFileSync(join(dir, "AGENTS.md"), "# stale\n");
      const out = appendMemoryFiles("BASE", memoryFileCandidates(dir, join(dir, "home")), readMemoryFile);
      expect(out).toContain("# current");
      expect(out).not.toContain("# stale");
    });
  });

  test("AGENTS.md is read on its own when there is no CLAUDE.md", () => {
    // The fallback is the whole point of supporting the name: plenty of repos
    // never had a CLAUDE.md to begin with.
    sandbox((dir) => {
      writeFileSync(join(dir, "AGENTS.md"), "# agents only\n");
      const out = appendMemoryFiles("BASE", memoryFileCandidates(dir, join(dir, "home")), readMemoryFile);
      expect(out).toContain("--- project context (AGENTS.md) ---\n# agents only");
    });
  });

  test("an empty CLAUDE.md does not shadow AGENTS.md", () => {
    sandbox((dir) => {
      writeFileSync(join(dir, "CLAUDE.md"), "   \n\n");
      writeFileSync(join(dir, "AGENTS.md"), "# agents only\n");
      const out = appendMemoryFiles("BASE", memoryFileCandidates(dir, join(dir, "home")), readMemoryFile);
      expect(out).toContain("# agents only");
    });
  });

  test("a directory in a memory file's place does not throw", () => {
    sandbox((dir) => {
      mkdirSync(join(dir, "CLAUDE.md"));
      expect(readMemoryFile(join(dir, "CLAUDE.md"))).toBeNull();
      expect(appendMemoryFiles("BASE", [{ path: join(dir, "CLAUDE.md"), label: "x" }], readMemoryFile)).toBe("BASE");
    });
  });
});

describe("the session builder uses this list", () => {
  test("agentSession appends it rather than a list of its own", () => {
    // The two lists drifted once already: /doctor counted files the session
    // never opened. One source, imported — not a second copy.
    const src = require("node:fs").readFileSync(
      join(import.meta.dir, "agent/agentSession.ts"),
      "utf8",
    ) as string;
    expect(src).toContain("appendMemoryFiles(instructions, memoryFileCandidates(workingDir))");
    expect(src).not.toContain('"DEEP.md"');
  });

  test("/doctor reports the files the session actually reads", () => {
    const src = require("node:fs").readFileSync(
      join(import.meta.dir, "../utils/doctorChecks.ts"),
      "utf8",
    ) as string;
    expect(src).toContain("memoryFileCandidates(cwd)");
    expect(src).not.toContain("DEEP.md");
  });
});
