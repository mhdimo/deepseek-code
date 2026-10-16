import { homedir } from "os";

/**
 * The status bar's directory and branch segments.
 *
 * One `git status --porcelain=v1 --branch` answers both questions — the first
 * line carries the branch, any other line means the tree is dirty — so polling
 * costs one process rather than two. A directory that is not a repository (or
 * has no git installed) answers null and the segment simply does not render;
 * the status bar is not the place to report a missing tool.
 */
export interface GitStatus {
  branch: string;
  /** Tracked or untracked changes — the `*` the branch segment carries. */
  dirty: boolean;
}

export function readGitStatus(cwd: string): GitStatus | null {
  try {
    const proc = Bun.spawnSync(["git", "status", "--porcelain=v1", "--branch"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;

    const lines = proc.stdout.toString().split("\n");
    const head = lines.shift() ?? "";
    if (!head.startsWith("## ")) return null;

    const spec = head.slice(3);
    let branch: string;
    if (spec.startsWith("No commits yet on ")) branch = spec.slice("No commits yet on ".length);
    else if (spec.startsWith("HEAD (no branch)")) branch = "detached";
    // "main...origin/main [ahead 1]" → "main"; a bare "main" is already it.
    else branch = spec.split("...")[0]!.split(" ")[0]!;

    return { branch, dirty: lines.some((line) => line.trim().length > 0) };
  } catch {
    return null;
  }
}

/** `/Users/you/project` → `~/project` — the home directory is the part of a
 *  path nobody reads. A path outside home is left as it is. `home` defaults
 *  to the real one and is a parameter so a test can name its own. */
export function formatWorkingDirectory(cwd: string, home: string = homedir()): string {
  if (!home || !cwd.startsWith(home)) return cwd;
  const rest = cwd.slice(home.length);
  return rest.startsWith("/") ? `~${rest}` : cwd;
}
