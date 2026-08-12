// EnterWorktreeTool — creates an isolated git worktree and returns its path
//
// Creates a new git worktree under `.deepseek-code/worktrees/` on a new branch
// based on the current HEAD. This gives sub-agents (or the main agent) an
// isolated checkout to work in without disturbing the caller's working tree.
//
// Git operations are performed via Bun.spawn. Requires Write permission because
// creating a worktree writes to the filesystem inside the repo.

import { resolve, join } from "path";
import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { ENTER_WORKTREE_TOOL_NAME, DESCRIPTION } from "./prompt.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const WORKTREE_DIR = ".deepseek-code/worktrees";
const BRANCH_PREFIX = "deepseek-worktree";
const MAX_NAME_LEN = 64;

// Allowed characters for each "/"-separated segment of the worktree name.
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

// ─── Input schema ────────────────────────────────────────────────────────────

const EnterWorktreeInputSchema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      "Optional name for the worktree. Each \"/\"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided.",
    ),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Validate a user-supplied worktree slug. Throws on invalid input. */
function validateWorktreeSlug(slug: string): void {
  if (slug.length === 0) {
    throw new Error("Worktree name must not be empty.");
  }
  if (slug.length > MAX_NAME_LEN) {
    throw new Error(
      `Worktree name must be at most ${MAX_NAME_LEN} characters (got ${slug.length}).`,
    );
  }
  if (slug.startsWith("/") || slug.endsWith("/")) {
    throw new Error("Worktree name must not start or end with '/'.");
  }
  for (const segment of slug.split("/")) {
    if (segment.length === 0) {
      throw new Error("Worktree name contains an empty segment.");
    }
    if (!SEGMENT_RE.test(segment)) {
      throw new Error(
        `Worktree name segment '${segment}' contains invalid characters. Only letters, digits, '.', '_', and '-' are allowed.`,
      );
    }
  }
  // Reject path traversal attempts.
  if (slug.includes("..")) {
    throw new Error("Worktree name must not contain '..'.");
  }
}

/** Generate a short random slug. */
function randomSlug(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

/** Sanitize a slug into a filesystem/git-safe path segment group. */
function sanitizeSlug(slug: string): string {
  // Collapse any runs of invalid characters into a single '-' and trim.
  return slug
    .split("/")
    .map((s) => s.replace(/[^A-Za-z0-9._-]+/g, "-"))
    .map((s) => s.replace(/^-+|-+$/g, ""))
    .filter((s) => s.length > 0)
    .join("/");
}

/** Spawn a process and capture stdout/stderr. Resolves with trimmed output. */
async function runGit(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Resolve the canonical git repository root for `cwd`.
 * Uses `git rev-parse --path-format=absolute --git-common-dir` so it returns the
 * main repository root even when invoked from within an existing worktree.
 * Returns null if `cwd` is not inside a git repository.
 */
async function findCanonicalGitRoot(cwd: string): Promise<string | null> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.code !== 0 || inside.stdout !== "true") {
    return null;
  }
  const common = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  );
  if (common.code !== 0 || !common.stdout) {
    // Fall back to --show-toplevel for non-worktree checkouts.
    const top = await runGit(["rev-parse", "--show-toplevel"], cwd);
    if (top.code !== 0 || !top.stdout) return null;
    return resolve(top.stdout);
  }
  // git-common-dir is `<root>/.git` for a normal repo; the parent is the root.
  return resolve(common.stdout, "..");
}

/** Check whether `cwd` is itself a worktree created under our worktree dir. */
function isInsideManagedWorktree(cwd: string, repoRoot: string): boolean {
  const managedRoot = resolve(repoRoot, WORKTREE_DIR);
  const normalizedCwd = resolve(cwd);
  return (
    normalizedCwd === managedRoot ||
    normalizedCwd.startsWith(managedRoot + "/")
  );
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const EnterWorktreeTool = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: EnterWorktreeInputSchema,

  userFacingName: (input) => {
    const n = input.name ? sanitizeSlug(input.name) : "worktree";
    return `Creating worktree ${n}`;
  },

  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  maxResultSizeChars: 100_000,

  checkPermissions: async (_input, context) => {
    if (!context.permissions.allowWrite) {
      return {
        approved: false,
        feedback: "Write permission denied for this agent.",
      };
    }
    return context.requestPermission(
      "EnterWorktree",
      "Create an isolated git worktree under .deepseek-code/worktrees/",
    );
  },

  call: async (
    input: z.infer<typeof EnterWorktreeInputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> => {
    const cwd = resolve(context.workingDir);

    // 1. Find the canonical git root.
    const repoRoot = await findCanonicalGitRoot(cwd);
    if (!repoRoot) {
      return {
        data: "Error: not inside a git repository. EnterWorktree requires a git repo.",
      };
    }

    // 2. Refuse if we're already inside one of our managed worktrees.
    if (isInsideManagedWorktree(cwd, repoRoot)) {
      return {
        data: "Error: already inside a managed worktree (.deepseek-code/worktrees/). Refusing to create a nested worktree.",
      };
    }

    // 3. Resolve + validate the worktree name.
    let rawName: string;
    try {
      rawName = input.name ? input.name.trim() : "";
      if (rawName) {
        validateWorktreeSlug(rawName);
      }
    } catch (e) {
      return { data: `Error: ${(e as Error).message}` };
    }
    const slug = rawName ? sanitizeSlug(rawName) : randomSlug();
    if (!slug) {
      return { data: "Error: invalid worktree name resolved to empty string." };
    }

    // 4. Compute the target path and branch.
    const worktreePath = resolve(repoRoot, WORKTREE_DIR, slug);
    const branchName = `${BRANCH_PREFIX}/${slug}`;

    // 5. Ensure the worktree base dir exists (git creates the leaf, not parents).
    const baseDir = resolve(repoRoot, WORKTREE_DIR);
    try {
      await Bun.write(baseDir + "/.gitkeep", "");
    } catch {
      // mkdir -p semantics via a no-op file write into the directory.
      // Bun.write creates parent directories automatically.
    }

    // 6. Create the worktree on a new branch from HEAD.
    //    `git worktree add -b <branch> <path>` fails if the branch already
    //    exists, which is the safety we want.
    const add = await runGit(
      ["worktree", "add", "-b", branchName, worktreePath],
      repoRoot,
    );
    if (add.code !== 0) {
      // Common failure: branch already exists. Try once with a unique branch
      // name so a retry-friendly path is returned rather than a hard failure.
      if (add.stderr.includes("already exists")) {
        const unique = `${branchName}-${Date.now().toString(36)}`;
        const retry = await runGit(
          ["worktree", "add", "-b", unique, worktreePath],
          repoRoot,
        );
        if (retry.code !== 0) {
          return {
            data: `Error creating worktree (retry): ${retry.stderr || retry.stdout || "git worktree add failed"}`,
          };
        }
        return {
          data: formatSuccess(worktreePath, unique, { renamed: true, originalBranch: branchName }),
        };
      }
      return {
        data: `Error creating worktree: ${add.stderr || add.stdout || "git worktree add failed"}`,
      };
    }

    return { data: formatSuccess(worktreePath, branchName) };
  },
});

// ─── Output formatting ───────────────────────────────────────────────────────

interface FormatOpts {
  renamed?: boolean;
  originalBranch?: string;
}

function formatSuccess(
  worktreePath: string,
  branchName: string,
  opts: FormatOpts = {},
): string {
  const note =
    opts.renamed && opts.originalBranch
      ? ` (branch '${opts.originalBranch}' already existed; created '${branchName}' instead)`
      : "";
  return [
    `Created worktree at ${worktreePath} on branch ${branchName}${note}.`,
    `The caller can now operate against this path for fully isolated work.`,
    `To remove the worktree later, run: git worktree remove ${JSON.stringify(worktreePath)} && git branch -D ${branchName}`,
  ].join("\n");
}

export { WORKTREE_DIR, BRANCH_PREFIX, validateWorktreeSlug };
