












export interface WorktreeSession {
  originalCwd: string;
  worktreePath: string;
  worktreeBranch?: string;
  originalHeadCommit?: string;
}




let currentSession: WorktreeSession | null = null;

export const WorktreeSessionStore = {
  
  register(session: WorktreeSession): void {
    currentSession = session;
  },

  
  get(): WorktreeSession | null {
    return currentSession;
  },

  
  clear(): void {
    currentSession = null;
  },

  
  hasActive(): boolean {
    return currentSession !== null;
  },
};
