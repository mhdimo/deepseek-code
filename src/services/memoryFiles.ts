/**
 * The memory files a session reads before its first turn.
 *
 * One list, deliberately: these paths are consumed by the session builder (to
 * put them in the system prompt) and by `/doctor` (to report how much context
 * they cost). When the two were separate lists they disagreed — `/doctor`
 * named files that landed in context and the session never opened two of them,
 * so a user could write instructions, see them counted on the doctor screen,
 * and watch the model answer as if they were not there.
 *
 * DEEP.md is deliberately absent. It was this app's own spelling for project
 * memory and nothing else reads it — not Claude Code, not the other agent
 * CLIs — so instructions written under that name were invisible everywhere the
 * user's other tools looked. AGENTS.md takes its place: same position, a name
 * the rest of the ecosystem actually opens.
 *
 * Order is precedence, least-specific first: user memory, then project, with
 * local overrides last. Later sections contradict earlier ones, and the model
 * is meant to read it that way.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MemoryFileCandidate {
  path: string;
  /** Shown to the model as the section header, so it can tell a user-level
   *  instruction from a project one. */
  label: string;
  /**
   * Skip this file when that one is also present and non-empty.
   *
   * For AGENTS.md, which is the same document as CLAUDE.md under a newer name.
   * Repos migrating between the two names keep both for a while, and the two
   * copies drift — after which reading both is worse than reading either: the
   * model gets two versions of one document and, because this list is ordered
   * by precedence, the stale one is the one that wins.
   *
   * CLAUDE.md is the one that wins because it is the name this app writes and
   * maintains. A repo carrying only AGENTS.md is read normally.
   */
  supersededBy?: string;
}

export interface PresentMemoryFile {
  path: string;
  label: string;
  content: string;
}

export function memoryFileCandidates(
  workingDir: string,
  home: string = homedir(),
): MemoryFileCandidate[] {
  return [
    { path: join(home, ".claude", "CLAUDE.md"), label: "user memory (~/.claude)" },
    { path: join(home, ".claude", "CLAUDE.local.md"), label: "user memory (~/.claude, local)" },
    { path: join(home, ".deepseek-code", "CLAUDE.md"), label: "user memory" },
    { path: join(workingDir, ".claude", "CLAUDE.md"), label: "project context (.claude)" },
    { path: join(workingDir, ".claude", "CLAUDE.local.md"), label: "project context (.claude, local)" },
    { path: join(workingDir, "CLAUDE.md"), label: "project context" },
    {
      path: join(workingDir, "AGENTS.md"),
      label: "project context (AGENTS.md)",
      supersededBy: join(workingDir, "CLAUDE.md"),
    },
  ];
}

/** Read a file for its text, or null when it is missing or unreadable. */
export function readMemoryFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Append each readable memory file as a labelled section.
 *
 * A missing file is not an error — most projects have none — and neither is an
 * unreadable one. Memory is context; failing to load context must not be the
 * thing that stops a session from starting.
 *
 * Identical content is appended once. `CLAUDE.md` and `AGENTS.md` are commonly
 * symlinked to each other, and `.claude/CLAUDE.md` back to the repo root, so
 * without this the same text arrives two or three times and reads to the model
 * as emphasis nobody gave it — besides being paid for in every request.
 *
 * Which copy survives is the later one, not the earlier: the label is what
 * tells the model which file it is reading, and a model that wants to update
 * project memory will update the file it was shown. Pointing it at
 * `.claude/CLAUDE.md` when the canonical `CLAUDE.md` holds the same bytes is
 * how the two copies stop matching in the first place.
 *
 * Every candidate is read before anything is taken, because whether a file is
 * included can depend on another one being there (`supersededBy`).
 */
export function presentMemoryFiles(
  files: readonly MemoryFileCandidate[],
  read: (path: string) => string | null = readMemoryFile,
): PresentMemoryFile[] {
  const found = new Map<string, string>();
  for (const file of files) {
    const content = read(file.path);
    if (content && content.trim()) found.set(file.path, content);
  }

  const eligible = files.filter((file) => {
    if (found.get(file.path) === undefined) return false;
    return !(file.supersededBy && found.has(file.supersededBy));
  });

  const out: PresentMemoryFile[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const file = eligible[i]!;
    const content = found.get(file.path)!;
    // A later eligible file holding the same bytes is the better one to name.
    // Only eligible ones count: a superseded duplicate is not a survivor.
    if (eligible.slice(i + 1).some((later) => found.get(later.path) === content)) continue;
    out.push({ path: file.path, label: file.label, content });
  }
  return out;
}

/** The memory files to put in the system prompt, as labelled sections. */
export function appendMemoryFiles(
  instructions: string,
  files: readonly MemoryFileCandidate[],
  read: (path: string) => string | null = readMemoryFile,
): string {
  let out = instructions;
  for (const file of presentMemoryFiles(files, read)) {
    out += `\n\n--- ${file.label} ---\n${file.content}`;
  }
  return out;
}
