/**
 * Protected paths are the writes that are never settled automatically.
 *
 * Each test here is one of the automatic approvals the guard has to outrank:
 * a settings allow rule, a session rule, acceptEdits, bypassPermissions, and
 * headless --print auto-approval. The guard is only ever allowed to *add* a
 * prompt — denials still deny — so the tests also pin what it must leave
 * alone: reads, ordinary project files, and this app's own worktree directory.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PATH_WRITE_TOOLS,
  isProtectedPath,
  pathWithinDir,
  pathWrittenBy,
  protectedWriteReason,
} from "./protectedPaths.js";

const sandbox = mkdtempSync(join(tmpdir(), "protected-paths-"));

describe("isProtectedPath", () => {
  test("a directory that runs code later", () => {
    expect(isProtectedPath("/repo/.git/hooks/pre-commit")).toBe("a protected directory (.git)");
    expect(isProtectedPath("/repo/.vscode/tasks.json")).toBe("a protected directory (.vscode)");
    expect(isProtectedPath("/home/u/.ssh/authorized_keys")).toBe("a protected directory (.ssh)");
  });

  test("a file that decides what runs later", () => {
    expect(isProtectedPath("/Users/someone/.zshrc")).toBe("a protected file (.zshrc)");
    expect(isProtectedPath("/repo/.mcp.json")).toBe("a protected file (.mcp.json)");
    expect(isProtectedPath("/repo/.gitconfig")).toBe("a protected file (.gitconfig)");
  });

  test("case-insensitively, because the filesystem is", () => {
    expect(isProtectedPath("/repo/.GIT/config")).toBe("a protected directory (.GIT)");
    expect(isProtectedPath("/Users/someone/.ZSHrc")).toBe("a protected file (.ZSHrc)");
    expect(isProtectedPath("/repo/.Claude/settings.json")).toBe("a protected directory (.Claude)");
  });

  test("ordinary project files are not protected", () => {
    expect(isProtectedPath("/repo/src/index.ts")).toBeNull();
    expect(isProtectedPath("/repo/.gitignore")).toBeNull();
    expect(isProtectedPath("/repo/git/hooks/pre-commit")).toBeNull();
  });

  test(".claude/worktrees is structure, not configuration", () => {
    // The app creates and removes these itself; gating them would break
    // EnterWorktree/ExitWorktree for no security gain.
    expect(isProtectedPath("/repo/.claude/worktrees/musing-archimedes/src/a.ts")).toBeNull();
    // A nested .claude inside the worktree is a real config directory again.
    expect(isProtectedPath("/repo/.claude/worktrees/wt/.claude/settings.json")).toBe(
      "a protected directory (.claude)",
    );
  });
});

describe("protectedWriteReason", () => {
  test("a write to a protected file, however it is spelled", () => {
    expect(protectedWriteReason("Write", { file_path: "~/.zshrc" }, sandbox)).toBe(
      "~/.zshrc is a protected file (.zshrc)",
    );
    expect(protectedWriteReason("Edit", { file_path: ".git/hooks/pre-commit" }, sandbox)).toContain(
      "a protected directory (.git)",
    );
    expect(protectedWriteReason("Write", { file_path: ".claude/settings.json" }, sandbox)).toContain(
      "a protected directory (.claude)",
    );
  });

  test("a relative path is resolved against the working directory", () => {
    const reason = protectedWriteReason("Write", { file_path: "config/.mcp.json" }, sandbox);
    expect(reason).toContain("a protected file (.mcp.json)");
  });

  test("a symlink into a protected directory is the protected directory", () => {
    mkdirSync(join(sandbox, ".git", "hooks"), { recursive: true });
    const link = join(sandbox, "friendly-hooks");
    symlinkSync(join(sandbox, ".git", "hooks"), link);
    expect(protectedWriteReason("Write", { file_path: join(link, "pre-commit") }, sandbox)).toContain(
      "a protected directory (.git)",
    );
  });

  test("reads are not gated — only writes change the file", () => {
    expect(protectedWriteReason("Read", { file_path: "~/.zshrc" }, sandbox)).toBeNull();
    expect(protectedWriteReason("Grep", { path: ".git" }, sandbox)).toBeNull();
  });

  test("an ordinary write is ordinary", () => {
    expect(protectedWriteReason("Write", { file_path: "src/app.ts" }, sandbox)).toBeNull();
    expect(protectedWriteReason("Edit", { file_path: "README.md" }, sandbox)).toBeNull();
  });

  test("every path-valued key is checked, not just file_path", () => {
    expect(protectedWriteReason("NotebookEdit", { notebook_path: ".claude/x.ipynb" }, sandbox)).toContain(
      "a protected directory (.claude)",
    );
  });

  test("the write tools are the ones that name a file", () => {
    expect([...PATH_WRITE_TOOLS].sort()).toEqual(["Edit", "NotebookEdit", "Write"]);
  });
});

describe("pathWrittenBy", () => {
  test("the file the call would write, resolved", () => {
    expect(pathWrittenBy("Write", { file_path: "src/a.ts" }, sandbox)).toBe(join(sandbox, "src/a.ts"));
    expect(pathWrittenBy("Write", { file_path: "~/notes.md" }, sandbox)).toBe(
      join(process.env.HOME ?? "", "notes.md"),
    );
  });

  test("a tool that does not write a named file has no target", () => {
    expect(pathWrittenBy("Read", { file_path: "src/a.ts" }, sandbox)).toBeNull();
    expect(pathWrittenBy("Write", {}, sandbox)).toBeNull();
  });
});

describe("pathWithinDir — the acceptEdits constraint", () => {
  test("inside, and the directory itself", () => {
    expect(pathWithinDir(join(sandbox, "src", "a.ts"), sandbox)).toBe(true);
    expect(pathWithinDir(sandbox, sandbox)).toBe(true);
  });

  test("outside", () => {
    expect(pathWithinDir(join(sandbox, "..", "elsewhere", "a.ts"), sandbox)).toBe(false);
    expect(pathWithinDir("/etc/hosts", sandbox)).toBe(false);
  });

  test("a sibling with the directory's name as a prefix is outside", () => {
    // `<sandbox>-notes` must not read as being inside `<sandbox>`.
    expect(pathWithinDir(`${sandbox}-notes/a.ts`, sandbox)).toBe(false);
  });

  test("a symlink out of the directory does not inherit the grant", () => {
    // The link sits inside the workspace; what it points at does not.
    const outside = mkdtempSync(join(tmpdir(), "protected-paths-outside-"));
    const link = join(sandbox, "escape");
    symlinkSync(outside, link);
    expect(pathWithinDir(join(link, "a.ts"), sandbox)).toBe(false);
  });

  test("the guard's own answer is what keeps acceptEdits honest", () => {
    expect(pathWithinDir(join(sandbox, ".git", "config"), sandbox)).toBe(true);
    expect(protectedWriteReason("Write", { file_path: join(sandbox, ".git", "config") }, sandbox)).not.toBeNull();
  });
});

/**
 * The wiring is the finding: the guard is worthless sitting in a module nobody
 * calls, and it is bypassed again the moment one of the auto-approval sites
 * stops consulting it. These read the sources because the failure they prevent
 * is a *decision order*, which a unit test of any one call site cannot see.
 */
describe("wiring", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

  test("the execute wrapper lets no allow rule skip a protected prompt", () => {
    const src = read("../tools.ts");
    expect(src).toContain("protectedWriteReason(");
    expect(src).toContain("ruleAllowed && !protectedReason");
  });

  test("the UI's auto-approvals all sit behind the guard", () => {
    const src = read("../components/App.tsx");
    const guard = src.indexOf("const protectedReason = protectedWriteReason(");
    expect(guard).toBeGreaterThan(-1);
    const bypass = src.indexOf('if (mode === "bypassPermissions")');
    const accept = src.indexOf('mode === "acceptEdits" && target !== null');
    expect(bypass).toBeGreaterThan(guard);
    expect(accept).toBeGreaterThan(guard);
    // A session allow rule is the third automatic approval, and it lives in
    // the same block: one `!protectedReason` gate covers all of them.
    expect(src).toContain("if (!protectedReason) {");
  });

  test("headless approval is not unconditional", () => {
    const src = read("../cli/print.ts");
    expect(src).toContain("protectedWriteReason(");
    expect(src).not.toContain("const autoApprove = async () => ({ approved: true })");
    // The escape hatch is the explicit flag, and it is off unless asked for:
    // a silent default would put back exactly the hole this closes.
    expect(src).toContain("dangerouslySkipPermissions: skipProtectedWrites = false");
    expect(src).toContain("createHeadlessApprover(workingDir, skipProtectedWrites)");
    // …and the flag is the one that is already gated for root at startup.
    expect(read("../index.tsx")).toContain(
      "dangerouslySkipPermissions: config.dangerouslySkipPermissions",
    );
  });
});
