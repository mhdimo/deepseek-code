// Task.ts — background task state model
//
// A lightweight, discriminated-union TaskState for background shell tasks
// spawned by BashTool(run_in_background: true). Modeled on Claude Code's
// src/Task.ts, but narrowed to a single task type (`shell`) since the C++
// backend owns agent/remote workflows. The registry itself lives in
// src/services/tasks/backgroundFramework.ts.
//
// NOTE: this is intentionally distinct from the TODO-list `TaskItem` in
// types/index.ts (used by TaskCreate/TaskGet/...). Background tasks model
// long-running OS processes; TODO items model planning entries.

import { randomBytes } from "crypto";

// ─── Task types & status ─────────────────────────────────────────────────────

/**
 * Kind of background task. Only `shell` is modeled today — kept as a union so
 * the discriminated-union `TaskState` can grow (e.g. `monitor`) without a
 * breaking change.
 */
export type TaskType = "shell";

export type TaskStatus = "running" | "done" | "error";

/**
 * True when a task is in a terminal state and will not transition further.
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "done" || status === "error";
}

// ─── Task state ──────────────────────────────────────────────────────────────

/** Fields shared by all task states (the base of the discriminated union). */
export interface TaskStateBase {
  /** Stable unique ID, prefixed by type (e.g. "b3f9a1c0"). */
  id: string;
  /** Discriminant — always "shell" today. */
  type: TaskType;
  /** Lifecycle status. */
  status: TaskStatus;
  /** The shell command that was executed. */
  command: string;
  /** Absolute path to the output log file (stdout+stderr). */
  outputPath: string;
  /** OS process id of the spawned child, when available. */
  pid: number | undefined;
  /** Epoch ms when the task was started. */
  startedAt: number;
  /** Epoch ms when the task reached a terminal state. */
  endedAt?: number;
  /** Process exit code, once known. */
  exitCode?: number;
  /** Human-readable error message, set when status === "error". */
  error?: string;
}

/** A running background shell. */
export interface RunningTaskState extends TaskStateBase {
  status: "running";
  exitCode?: never;
  endedAt?: never;
  error?: never;
}

/** A background shell that exited successfully (exit code 0). */
export interface DoneTaskState extends TaskStateBase {
  status: "done";
  exitCode: number;
  endedAt: number;
  error?: never;
}

/** A background shell that failed (non-zero exit, spawn error, or killed). */
export interface ErrorTaskState extends TaskStateBase {
  status: "error";
  exitCode?: number;
  endedAt: number;
  error?: string;
}

/**
 * Discriminated union of all task states. Narrow with `task.status`.
 */
export type TaskState = RunningTaskState | DoneTaskState | ErrorTaskState;

// ─── Task ID generation ──────────────────────────────────────────────────────

const TASK_ID_PREFIXES: Record<TaskType, string> = {
  // 'b' for bash/shell, matching Claude Code's local_bash convention.
  shell: "b",
};

// Case-insensitive-safe alphabet (digits + lowercase). 36^8 ≈ 2.8 trillion
// combinations — sufficient to resist brute-force symlink attacks on the
// shared task-outputs directory.
const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function generateTaskId(type: TaskType = "shell"): string {
  const prefix = TASK_ID_PREFIXES[type] ?? "b";
  const bytes = randomBytes(8);
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length];
  }
  return id;
}
