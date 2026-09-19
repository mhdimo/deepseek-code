/**
 * Paths that are never auto-approved.
 *
 * `dangerousOps.ts` is the floor for operations that are catastrophic *whatever*
 * the user intended: `rm -rf ~` is never the right answer, so it is refused
 * outright. This module covers a different case — edits the user very well may
 * want, but never *without being asked*. `.zshrc`, `.git/config` and
 * `.claude/settings.json` are writable in an ordinary session; what must not
 * happen is a broad "don't ask again for Write" rule, a Shift+Tab through
 * acceptEdits, or bypassPermissions quietly rewriting them.
 *
 * The rules the guard has to keep:
 *
 *   1. It outranks every automatic approval — settings rules, session rules,
 *      acceptEdits and bypassPermissions alike. A prompt is still a prompt.
 *   2. It matches case-insensitively and on the symlink-resolved path as well
 *      as the literal one: on a case-insensitive filesystem `.CLAUDE/settings.json`
 *      names the same file, and a symlink into `.git/` is the same directory.
 *   3. It is about writes. Reading `.git/HEAD` is how you find out where you
 *      are; only mutation of these paths is gated.
 */

import { basename, dirname, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { PATH_INPUT_KEYS, resolvePath } from "../utils/toolUtils.js";

/**
 * Directories that hold configuration or executable material for the tools a
 * developer already trusts. `.git/hooks/pre-commit` is arbitrary code execution
 * on the next commit; `.vscode/tasks.json` is the same on the next build.
 *
 * `.claude/worktrees` is carved out below: that directory is structure this app
 * creates and removes itself, not user configuration.
 */
export const PROTECTED_DIRECTORIES = [".git", ".claude", ".vscode", ".idea", ".ssh"] as const;

/**
 * Files whose contents decide what runs later (`.bashrc`, `.zshrc`, `.profile`),
 * where code is fetched from (`.gitconfig`'s `insteadOf`, `.gitmodules`), or how
 * this app and its MCP servers behave (`.mcp.json`, `.claude.json`).
 */
export const PROTECTED_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".claude.json",
] as const;

const DIRECTORY_SET = new Set<string>(PROTECTED_DIRECTORIES);
const FILE_SET = new Set<string>(PROTECTED_FILES);

/**
 * The tools that mutate the file the model named, as opposed to the tools that
 * merely take a path. This is a name list rather than the `allowWrite`
 * capability because this module is also consulted from the UI, which has the
 * tool's name and nothing else — and because `allowWrite` also covers the
 * worktree tools, whose `.claude/worktrees` paths are structural.
 */
export const PATH_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "NotebookEdit"]);

/**
 * Resolve symlinks as far as the path exists. A file that is about to be created
 * has no inode to resolve, but its parent directory does — and a symlinked
 * parent is exactly how `.git/hooks` gets reached through a friendlier name.
 */
export function resolveSymlinks(path: string): string {
  const p = resolve(path);
  const pending: string[] = [];
  let current = p;
  // Terminates at the filesystem root, which always exists.
  for (;;) {
    try {
      return pending.length === 0 ? realpathSync(current) : join(realpathSync(current), ...pending);
    } catch {
      const parent = dirname(current);
      if (parent === current) return p;
      pending.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * A human-readable reason when `path` is protected, or null when it is ordinary.
 * The comparison is case-insensitive; the caller decides which spellings of the
 * path to hand in (see `protectedWriteReason`).
 */
export function isProtectedPath(path: string): string | null {
  const segments = resolve(path).split(/[\\/]+/).filter((s) => s.length > 0);
  const lowered = segments.map((s) => s.toLowerCase());

  for (let i = 0; i < segments.length; i++) {
    const segment = lowered[i]!;
    if (!DIRECTORY_SET.has(segment)) continue;
    // `.claude/worktrees` is where worktrees are kept — structure the app
    // created, not the user's configuration directory. A nested `.claude`
    // inside the worktree is still protected.
    if (segment === ".claude" && lowered[i + 1] === "worktrees") continue;
    return `a protected directory (${segments[i]})`;
  }

  const name = segments[segments.length - 1];
  if (name !== undefined && FILE_SET.has(name.toLowerCase())) {
    return `a protected file (${name})`;
  }
  return null;
}

/** Every path this input names, in each spelling the guard has to consider. */
function* pathInputs(
  input: Record<string, unknown> | undefined,
  workingDir: string,
): Generator<{ raw: string; resolved: string; canonical: string }> {
  if (!input) return;
  for (const key of PATH_INPUT_KEYS) {
    const raw = input[key];
    if (typeof raw !== "string" || raw.length === 0) continue;
    const resolved = resolvePath(workingDir, raw);
    yield { raw, resolved, canonical: resolveSymlinks(resolved) };
  }
}

/** The file this call would write, resolved, or null if it names none. */
export function pathWrittenBy(
  toolName: string,
  input: Record<string, unknown> | undefined,
  workingDir: string,
): string | null {
  if (!PATH_WRITE_TOOLS.has(toolName)) return null;
  for (const { resolved } of pathInputs(input, workingDir)) return resolved;
  return null;
}

/**
 * The reason a write by this tool needs a human, or null when the call is
 * ordinary. Both the literal and the symlink-resolved path are checked, so
 * neither a mixed-case spelling nor a symlink into `.git/` slips past.
 */
export function protectedWriteReason(
  toolName: string,
  input: Record<string, unknown> | undefined,
  workingDir: string,
): string | null {
  if (!PATH_WRITE_TOOLS.has(toolName)) return null;
  for (const { raw, resolved, canonical } of pathInputs(input, workingDir)) {
    const hit =
      isProtectedPath(resolved) ?? (canonical !== resolved ? isProtectedPath(canonical) : null);
    if (hit) return `${raw} is ${hit}`;
  }
  return null;
}

/**
 * Is `path` inside `dir` (or `dir` itself)? Used to keep acceptEdits to the
 * working directory: "auto-approve edits" is a grant about this project, not
 * about the machine. Both sides are compared after symlink resolution, so a
 * link inside the workspace that points out of it does not inherit the grant.
 */
export function pathWithinDir(path: string, dir: string): boolean {
  const leaf = resolveSymlinks(path);
  const root = resolveSymlinks(dir);
  // Case-insensitive filesystems (macOS, Windows) make `.Claude` and `.claude`
  // the same directory; a case-sensitive comparison would disagree with the OS.
  const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
  const [a, b] = caseInsensitive ? [leaf.toLowerCase(), root.toLowerCase()] : [leaf, root];
  const rel = relative(b, a);
  // `relative` returns "" for the directory itself and a `..` prefix for
  // anything outside it. A sibling named `project-notes` must not count as
  // being inside `project`, which is why this is not a `startsWith` on the
  // raw strings.
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}
