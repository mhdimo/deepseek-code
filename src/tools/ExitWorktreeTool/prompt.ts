export const EXIT_WORKTREE_TOOL_NAME = "ExitWorktree";

export const DESCRIPTION = `Exit a worktree session created by EnterWorktree and return the session to the original working directory.

Use this tool ONLY when the user explicitly asks to exit, leave, or go back from a worktree session. Do NOT call it proactively.

## Scope

This tool ONLY operates on worktrees created by EnterWorktree in the CURRENT session. It will NOT touch:
- Worktrees you created manually with \`git worktree add\`
- Worktrees from a previous session (even if created by EnterWorktree then)
- The directory you are in if EnterWorktree was never called

If called outside an active EnterWorktree session, the tool is a no-op: it reports that no worktree session is active and takes no action. Filesystem state is unchanged.

## Parameters

- \`action\` (required): \`"keep"\` or \`"remove"\`.
  - \`"keep"\` — leave the worktree directory and its branch intact on disk. Use this if the user wants to come back to the work later, or if there are changes to preserve.
  - \`"remove"\` — delete the worktree directory and its branch. Use this for a clean exit when the work is done or abandoned. This is destructive and irreversible.
- \`discard_changes\` (optional, default false): only meaningful with \`action: "remove"\`. If the worktree has uncommitted files or commits not present on the original branch, the tool REFUSES to remove it unless this is \`true\`. If the tool returns an error listing changes, confirm with the user before re-invoking with \`discard_changes: true\`.

## Behavior

- Restores the session's working directory to where it was before EnterWorktree.
- On \`"remove"\`, deletes the worktree directory and its branch (requires \`allowWrite\`).
- Once exited, EnterWorktree can be called again to create a fresh worktree.`;
