















import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { EXIT_WORKTREE_TOOL_NAME, DESCRIPTION } from "./prompt.js";
import { WorktreeSessionStore } from "./worktreeSession.js";



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



interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}


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


async function removeWorktreeAndBranch(
  worktreePath: string,
  worktreeBranch: string | undefined,
): Promise<string> {
  const notes: string[] = [];

  const remove = await runGit(["worktree", "remove", "--force", worktreePath]);
  if (remove.code !== 0) {
    
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
    
    
    if (!context.permissions.allowWrite) {
      return {
        approved: false,
        feedback: "Write permission denied for this agent.",
      };
    }

    const session = WorktreeSessionStore.get();
    if (!session) {
      
      
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
      
      
      return {
        data:
          "No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session — it will not touch worktrees created manually or in a previous session. No filesystem changes were made.",
      };
    }

    const { originalCwd, worktreePath, worktreeBranch, originalHeadCommit } =
      session;

    
    
    
    const summary =
      (await countWorktreeChanges(worktreePath, originalHeadCommit)) ?? {
        changedFiles: 0,
        commits: 0,
      };
    const { changedFiles, commits } = summary;

    
    if (input.action === "remove" && !input.discard_changes) {
      
      
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

    
    if (input.action === "keep") {
      
      
      
      try {
        process.chdir(originalCwd);
      } catch {
        
      }
      WorktreeSessionStore.clear();

      return {
        data: `Exited worktree. Your work is preserved at ${worktreePath}${
          worktreeBranch ? ` on branch ${worktreeBranch}` : ""
        }. Session working directory restored to ${originalCwd}. You can re-enter with EnterWorktree later.`,
      };
    }

    
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
