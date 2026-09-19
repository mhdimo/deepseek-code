import React, { useState } from "react";
import { Box, Text } from "ink";
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
  /** The built-in rows the reference names ("User memory" / "Project memory")
   *  instead of labelling with a path. Only path-labelled rows take the
   *  "(new)" marker. */
  named?: boolean;
}

/** Candidate instruction files: user memory first, then project files. */
export function memoryCandidates(workingDirectory: string): MemoryCandidate[] {
  return [
    {
      path: USER_MEMORY_PATH,
      label: "User memory",
      description: "Saved in ~/.deepseek-code/CLAUDE.md",
      kind: "user",
      named: true,
    },
    {
      path: resolve(workingDirectory, "CLAUDE.md"),
      label: "Project memory",
      description: "Project memory — loaded into context for future sessions",
      kind: "project",
      named: true,
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
    const newMarker = candidate.named || exists ? "" : " (new)";
    return {
      label: `${candidate.label}${newMarker}`,
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

  // Reference /memory: titled "Memory" in the remember colour, with no
  // subtitle, and guided by the dialog's own Enter/Esc row rather than a
  // bespoke footer.
  return (
    <Dialog title="Memory" color="remember" onCancel={onClose}>
      <Select
        options={options}
        defaultValue={initialValue}
        // No visibleOptionCount: the reference passes none on this screen, so
        // Select's own default window (5) applies.
        onChange={(value) => {
          lastSelectedPath = value;
          onOpenInEditor(value);
        }}
        onCancel={onClose}
      />
      <Box marginTop={1}>
        <Text dimColor>Learn more: https://api-docs.deepseek.com</Text>
      </Box>
    </Dialog>
  );
}
