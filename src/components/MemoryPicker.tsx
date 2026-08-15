import React, { useState } from "react";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select, type SelectOption } from "../ui/design-system/Select.js";
import { homedir } from "node:os";
import { resolve, basename, join } from "node:path";
import { existsSync } from "node:fs";

export interface MemoryPickerProps {
  workingDirectory: string;
  /** Open the file in $EDITOR (App pauses raw mode around the spawn). Creates the file first when missing. */
  onOpenInEditor: (path: string) => void;
  onClose: () => void;
}

// Remember the last-selected path across /memory invocations (reference parity).
let lastSelectedPath: string | undefined;

/** User-level memory file (~/.deepseek-code/CLAUDE.md). */
export const USER_MEMORY_PATH = join(homedir(), ".deepseek-code", "CLAUDE.md");

export interface MemoryCandidate {
  path: string;
  label: string;
  description: string;
  kind: "user" | "project";
}

/** Candidate instruction files: user memory first, then project files. */
export function memoryCandidates(workingDirectory: string): MemoryCandidate[] {
  return [
    {
      path: USER_MEMORY_PATH,
      label: "User memory",
      description: "Saved in ~/.deepseek-code/CLAUDE.md",
      kind: "user",
    },
    {
      path: resolve(workingDirectory, "CLAUDE.md"),
      label: "CLAUDE.md (project)",
      description: "Project memory — loaded into context for future sessions",
      kind: "project",
    },
    {
      path: resolve(workingDirectory, "DEEP.md"),
      label: "DEEP.md (project)",
      description: "Loaded into context for future sessions",
      kind: "project",
    },
    {
      path: resolve(workingDirectory, "AGENTS.md"),
      label: "AGENTS.md (project)",
      description: "Agent instructions file read when working in this repo",
      kind: "project",
    },
  ];
}

/** True when `dir` sits inside a git checkout (`.git` dir or worktree file). */
export function isInGitRepo(dir: string): boolean {
  return existsSync(resolve(dir, ".git"));
}

/** Select options for the memory picker — "(new)" on missing files, git-aware descriptions. */
export function buildMemoryOptions(workingDirectory: string): SelectOption<string>[] {
  const isGit = isInGitRepo(workingDirectory);
  return memoryCandidates(workingDirectory).map((candidate) => {
    const exists = existsSync(candidate.path);
    const isProjectClaudeMd = candidate.kind === "project" && basename(candidate.path) === "CLAUDE.md";
    const description =
      candidate.kind === "user"
        ? "Saved in ~/.deepseek-code/CLAUDE.md"
        : isProjectClaudeMd
          ? `${isGit ? "Checked in at" : "Saved in"} ./CLAUDE.md`
          : candidate.description;
    return {
      label: `${candidate.label}${exists ? "" : " (new)"}`,
      value: candidate.path,
      description,
    };
  });
}

/**
 * Interactive /memory picker (Claude Code MemoryFileSelector equivalent):
 * choose a memory/instructions file to edit. Missing files are created on
 * open by App's openInEditor.
 */
export default function MemoryPicker({
  workingDirectory,
  onOpenInEditor,
  onClose,
}: MemoryPickerProps): React.ReactElement {
  const [options] = useState(() => buildMemoryOptions(workingDirectory));
  const initialValue =
    lastSelectedPath && options.some((o) => o.value === lastSelectedPath) ? lastSelectedPath : options[0]?.value;

  return (
    <Dialog
      title="Memory files"
      subtitle="Instructions files that steer the agent in this project"
      onCancel={onClose}
      footer="↑↓ to choose · enter to open in $EDITOR · esc to cancel"
    >
      <Select
        options={options}
        defaultValue={initialValue}
        onChange={(value) => {
          lastSelectedPath = value;
          onOpenInEditor(value);
        }}
        onCancel={onClose}
      />
    </Dialog>
  );
}
