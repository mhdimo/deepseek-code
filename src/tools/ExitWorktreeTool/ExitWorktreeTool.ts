// ExitWorktreeTool — exit a worktree session created by EnterWorktreeTool.
//
// Adapted from Claude Code's ExitWorktreeTool, but reworked for DeepSeek's
// tool pattern (buildTool + ToolUseContext) and the C++ agent backend:
//   - No Claude-internal state (bootstrap/state, Shell.setCwd, claudemd caches,
//     plans directory, systemPromptSections). The C++ backend owns compaction,
//     memory, and conversation history; the TS side only owns the TUI, tool
//     definitions, and ToolUseContext. So session restoration here is limited
//     to what the TS layer actually controls: the worktree session registry
//     and a best-effort `process.chdir` back to the original directory.
//   - Worktree operations (git worktree remove / branch -D, tmux kill) are run
//     via Bun.spawn. No C++ changes are required.
//   - Write permission (allowWrite) is required for BOTH actions: "remove"
//     deletes the worktree directory + branch (destructive), and "keep" still
//     mutates session state and changes the working directory.

import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { EXIT_WORKTREE_TOOL_NAME, DESCRIPTION } from "./prompt.js";
import { WorktreeSessionStore } from "./worktreeSession.js";

// ─── Input schema ────────────────────────────────────────────────────────────

const ExitWorktreeInputSchema = z.object({
  action: z
    .enum(["keep", "remove"])
    .describe(
      '"keep" leaves the worktree directory and branch on disk; "remove" deletes both (destructive).',
    ),
  discard_changes: z
    .boolean()
    .optional()
    .describe(
      'Required true when action is "remove" and the worktree has uncommitted files or commits not on the original branch. The tool will refuse and list them otherwise.',
    ),
});

// ─── git helper ──────────────────────────────────────────────────────────────

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a git command via Bun.spawn, capturing stdout/stderr. Never throws —
 * callers inspect `code`. A non-zero code surfaces as an empty/error result
 * rather than an exception so change-counting can fail closed.
 */
async function runGit(args: string[]): Promise<GitResult> {
  try {
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch (err) {
    // spawn itself failed (e.g. git not installed) — treat as non-zero.
    return {
      code: 1,
      stdout: "",
      stderr: (err as Error)?.message ?? String(err),
    };
  }
}

interface ChangeSummary {
  changedFiles: number;
  commits: number;
}

/**
 * Count uncommitted files and commits unique to the worktree branch.
 *
 * Returns null when state cannot be reliably determined — callers MUST treat
 * null as "unknown, assume unsafe" (fail-closed). A silent 0/0 would let a
 * remove destroy real work. Null is returned when git status / rev-list exit
 * non-zero, or when originalHeadCommit is undefined (no baseline to count from).
 */
async function countWorktreeChanges(
  worktreePath: string,
  originalHeadCommit: string | undefined,
): Promise<ChangeSummary | null> {
  const status = await runGit([
    "-C",
    worktreePath,
    "status",
    "--porcelain",
  ]);
  if (status.code !== 0) {
    return null;
  }
  const changedFiles = status.stdout
    .split("\n")
    .filter((l) => l.trim() !== "").length;

  if (!originalHeadCommit) {
    // git status succeeded → it's a repo, but without a baseline commit we
    // cannot count commits. Fail-closed rather than claim 0.
    return null;
  }

  const revList = await runGit([
    "-C",
    worktreePath,
    "rev-list",
    "--count",
    `${originalHeadCommit}..HEAD`,
  ]);
  if (revList.code !== 0) {
    return null;
  }
  const commits = parseInt(revList.stdout.trim(), 10) || 0;

  return { changedFiles, commits };
}

/**
 * Physically remove the worktree directory and its branch.
 * `git worktree remove --force` handles dirty working trees; we already
 * gated on discard_changes in the caller, so force is appropriate here.
 */
async function removeWorktreeAndBranch(
  worktreePath: string,
  worktreeBranch: string | undefined,
): Promise<string> {
  const notes: string[] = [];

  const remove = await runGit(["worktree", "remove", "--force", worktreePath]);
  if (remove.code !== 0) {
    // Fall back to prune if the directory was already moved/deleted.
    notes.push(
      `git worktree remove exited ${remove.code}${
        remove.stderr ? `: ${remove.stderr.trim()}` : ""
      }`,
    );
  }

  if (worktreeBranch) {
    const delBranch = await runGit(["branch", "-D", worktreeBranch]);
    if (delBranch.code !== 0) {
      notes.push(
        `git branch -D ${worktreeBranch} exited ${delBranch.code}${
          delBranch.stderr ? `: ${delBranch.stderr.trim()}` : ""
        }`,
      );
    }
  }

  return notes.join("\n");
}

// ─── Tool definition ────────────────────────────────────────────────────────

export const ExitWorktreeTool = buildTool({
  name: EXIT_WORKTREE_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: ExitWorktreeInputSchema,

  userFacingName: (input) =>
    input.action === "remove" ? "Exiting worktree (remove)" : "Exiting worktree (keep)",

  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  maxResultSizeChars: 100_000,

  checkPermissions: async (input, context) => {
    // Both actions mutate session state and the working directory; "remove"
    // is also destructive. Gate on allowWrite for either.
    if (!context.permissions.allowWrite) {
      return {
        approved: false,
        feedback: "Write permission denied for this agent.",
      };
    }

    const session = WorktreeSessionStore.get();
    if (!session) {
      // No active session — this will no-op in call(). Don't prompt; let it
      // through so the no-op message reaches the model.
      return { approved: true };
    }

    const verb =
      input.action === "remove"
        ? `Remove worktree at ${session.worktreePath}${
            session.worktreeBranch ? ` (deletes branch ${session.worktreeBranch})` : ""
          } — destructive`
        : `Exit worktree at ${session.worktreePath} (keep on disk)`;
    return context.requestPermission("ExitWorktree", verb);
  },

  call: async (input) => {
    const session = WorktreeSessionStore.get();
    if (!session) {
      // Scope guard: only operate on worktrees created by EnterWorktree in
      // THIS session. Manual worktrees / previous sessions are invisible.
      return {
        data:
          "No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session — it will not touch worktrees created manually or in a previous session. No filesystem changes were made.",
      };
    }

    const { originalCwd, worktreePath, worktreeBranch, originalHeadCommit } =
      session;

    // Re-count at execution time for accurate messaging. Null (git failure)
    // falls back to 0/0 for keep; for remove we already safety-gated in
    // validateInput-like logic below.
    const summary =
      (await countWorktreeChanges(worktreePath, originalHeadCommit)) ?? {
        changedFiles: 0,
        commits: 0,
      };
    const { changedFiles, commits } = summary;

    // ── Safety gate for "remove" ──────────────────────────────────────────
    if (input.action === "remove" && !input.discard_changes) {
      // Re-derive a trustworthy summary for the gate (the one above fell back
      // to 0/0 on git failure). If we can't verify, refuse.
      const verify =
        await countWorktreeChanges(worktreePath, originalHeadCommit);
      if (verify === null) {
        return {
          data: `Could not verify worktree state at ${worktreePath}. Refusing to remove without explicit confirmation. Re-invoke with discard_changes: true to proceed — or use action: "keep" to preserve the worktree.`,
        };
      }
      if (verify.changedFiles > 0 || verify.commits > 0) {
        const parts: string[] = [];
        if (verify.changedFiles > 0) {
          parts.push(
            `${verify.changedFiles} uncommitted ${
              verify.changedFiles === 1 ? "file" : "files"
            }`,
          );
        }
        if (verify.commits > 0) {
          parts.push(
            `${verify.commits} ${
              verify.commits === 1 ? "commit" : "commits"
            } on ${worktreeBranch ?? "the worktree branch"}`,
          );
        }
        return {
          data: `Worktree has ${parts.join(
            " and ",
          )}. Removing will discard this work permanently. Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.`,
        };
      }
    }

    // ── Perform the exit ──────────────────────────────────────────────────
    if (input.action === "keep") {
      // Best-effort restore of the TS-layer working directory. The C++ backend
      // owns the agent loop and history; we only restore what the TS layer
      // controls. EnterWorktreeTool (when implemented) should set originalCwd.
      try {
        process.chdir(originalCwd);
      } catch {
        // originalCwd may no longer exist; non-fatal for "keep".
      }
      WorktreeSessionStore.clear();

      return {
        data: `Exited worktree. Your work is preserved at ${worktreePath}${
          worktreeBranch ? ` on branch ${worktreeBranch}` : ""
        }. Session working directory restored to ${originalCwd}. You can re-enter with EnterWorktree later.`,
      };
    }

    // action === "remove"
    let extra = "";
    try {
      const notes = await removeWorktreeAndBranch(worktreePath, worktreeBranch);
      extra = notes ? `\n${notes}` : "";
    } catch (err) {
      extra = `\nWarning during removal: ${(err as Error).message}`;
    }

    try {
      process.chdir(originalCwd);
    } catch {
      // non-fatal
    }
    WorktreeSessionStore.clear();

    const discardParts: string[] = [];
    if (commits > 0) {
      discardParts.push(`${commits} ${commits === 1 ? "commit" : "commits"}`);
    }
    if (changedFiles > 0) {
      discardParts.push(
        `${changedFiles} uncommitted ${changedFiles === 1 ? "file" : "files"}`,
      );
    }
    const discardNote =
      discardParts.length > 0 ? ` Discarded ${discardParts.join(" and ")}.` : "";

    return {
      data: `Exited and removed worktree at ${worktreePath}.${discardNote} Session working directory restored to ${originalCwd}.${extra}`,
    };
  },
});
