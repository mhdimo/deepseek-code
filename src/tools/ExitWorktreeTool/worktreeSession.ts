// WorktreeSessionStore — in-memory registry of worktree sessions created by
// EnterWorktreeTool.
//
// DeepSeek's agent loop, streaming, and conversation history live in the C++
// backend (ai-sdk-cpp), but tool execution happens on the JS side through the
// async-tool bridge (see src/tools.ts → toolsToBindingFormat). That means a
// module-level store here is shared by every tool call within a single Node/Bun
// process, which is exactly the scope EnterWorktree/ExitWorktree need to
// coordinate. This is deliberately NOT persisted: a worktree created in a
// previous process is invisible to ExitWorktree (fail-closed — we never delete
// a worktree we didn't create this session).

/**
 * A worktree session registered by EnterWorktreeTool.
 *
 * - `originalCwd`: the process working directory before entering the worktree.
 *   ExitWorktree restores it.
 * - `worktreePath`: absolute path to the worktree directory.
 * - `worktreeBranch`: the branch checked out in the worktree (may be undefined
 *   for detached HEAD).
 * - `originalHeadCommit`: the commit the worktree branch was created from.
 *   Used to count how many commits are unique to the worktree. Undefined when
 *   the baseline is unknown — treated as "cannot prove clean" (fail-closed).
 */
export interface WorktreeSession {
  originalCwd: string;
  worktreePath: string;
  worktreeBranch?: string;
  originalHeadCommit?: string;
}

// Singleton session slot. EnterWorktree registers at most one active session;
// ExitWorktree reads then clears it. A plain variable (not a Map) mirrors the
// "one active worktree per session" contract and keeps the surface tiny.
let currentSession: WorktreeSession | null = null;

export const WorktreeSessionStore = {
  /** Register a worktree session (called by EnterWorktreeTool). */
  register(session: WorktreeSession): void {
    currentSession = session;
  },

  /** The active worktree session, or null if EnterWorktree hasn't run this session. */
  get(): WorktreeSession | null {
    return currentSession;
  },

  /** Clear the active session (called by ExitWorktreeTool after exit). */
  clear(): void {
    currentSession = null;
  },

  /** Whether an active EnterWorktree session exists. */
  hasActive(): boolean {
    return currentSession !== null;
  },
};
