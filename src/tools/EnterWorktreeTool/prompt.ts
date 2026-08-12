export const ENTER_WORKTREE_TOOL_NAME = "EnterWorktree";

export const DESCRIPTION = `Creates an isolated git worktree and returns its absolute path. Use this tool ONLY when the user explicitly asks to work in a worktree (e.g. "start a worktree", "work in a worktree", "create a worktree", "use a worktree").

## When to Use
- The user explicitly says "worktree" and wants an isolated workspace for feature work, sub-agents, or experimentation.

## When NOT to Use
- The user asks to create a branch, switch branches, or work on a different branch — use git commands via the Bash tool instead.
- The user asks to fix a bug or work on a feature — use normal git workflow unless they specifically mention worktrees.
- Never use this tool unless the user explicitly mentions "worktree".

## Requirements
- Must be run inside a git repository.
- Must not already be inside a \`.deepseek-code/worktrees/\` worktree.

## Behavior
- Resolves the canonical git repository root from the current working directory (so worktree creation works even when invoked from within an existing worktree or a subdirectory).
- Creates a new git worktree inside \`.deepseek-code/worktrees/\` on a fresh branch based on the current HEAD.
- Returns the absolute path of the new worktree and the branch name. The caller (e.g. a sub-agent) can then operate against that path for fully isolated work.

## Parameters
- \`name\` (optional): A name for the worktree. Each \`/\`-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided.`;
