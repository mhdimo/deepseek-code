// backgroundFramework.ts — in-memory registry for background shell tasks
//
// Owns the lifecycle of background tasks spawned by BashTool(run_in_background:
// true). Each task's stdout+stderr is redirected to a file under
// ~/.deepseek-code/task-outputs/; the registry watches the detached process,
// updates status on exit, and exposes tail/kill helpers used by TaskOutputTool
// and TaskStopTool.
//
// In-memory only: tasks do not survive a DeepSeek Code restart (the OS process
// does, but the registry entry is lost). This matches the session-scoped nature
// of the TUI; persistence is intentionally out of scope.
//
// NOT to be confused with src/services/tasks/TaskStore.ts, which stores the
// TODO-list `TaskItem` planning entries.

import { spawn, type ChildProcess } from "child_process";
import {
  openSync,
  closeSync,
  mkdirSync,
  readFileSync,
  readSync,
  statSync,
  existsSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  generateTaskId,
  isTerminalTaskStatus,
  type TaskState,
  type TaskStatus,
  type TaskType,
} from "../../Task.js";

// ─── Paths ───────────────────────────────────────────────────────────────────

const TASK_OUTPUT_DIR = join(homedir(), ".deepseek-code", "task-outputs");

/** Directory where background task output logs are written. */
export function getTaskOutputDir(): string {
  return TASK_OUTPUT_DIR;
}

/** Resolve the absolute output-file path for a task id. */
export function getTaskOutputPath(id: string): string {
  return join(TASK_OUTPUT_DIR, `${id}.log`);
}

function ensureOutputDir(): void {
  if (!existsSync(TASK_OUTPUT_DIR)) {
    mkdirSync(TASK_OUTPUT_DIR, { recursive: true });
  }
}

// ─── Registry ────────────────────────────────────────────────────────────────

/** Tracks the live ChildProcess alongside its persisted state. */
interface RegistryEntry {
  state: TaskState;
  /** The spawned process. Undefined after the process exits and is reaped. */
  child: ChildProcess | undefined;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Spawn a detached background shell task.
 *
 * stdout+stderr are appended to the task's output file. The process is
 * detached (unref'd) so it survives the parent DeepSeek Code process; its exit
 * is observed via the close handler which transitions the state.
 *
 * Returns the new task id and its state. The caller (BashTool) returns
 * immediately without waiting for completion.
 */
export function registerTask(
  command: string,
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    type?: TaskType;
  },
): TaskState {
  ensureOutputDir();

  const id = generateTaskId(opts.type ?? "shell");
  const outputPath = getTaskOutputPath(id);

  // Open (create/truncate) the output file and redirect the child's
  // stdout+stderr to it. Using fd redirection avoids buffering in JS and lets
  // the file grow even after we return.
  const outFd = openSync(outputPath, "w");

  const child = spawn("sh", ["-c", command], {
    cwd: opts.cwd,
    stdio: ["ignore", outFd, outFd],
    env: { ...process.env, FORCE_COLOR: "0", ...(opts.env ?? {}) },
    detached: true,
  });

  // The child holds its own dup'd fd; close ours in the parent.
  try {
    closeSync(outFd);
  } catch {
    // best-effort
  }

  const pid = typeof child.pid === "number" ? child.pid : undefined;
  const startedAt = Date.now();

  const entry: RegistryEntry = {
    state: {
      id,
      type: opts.type ?? "shell",
      status: "running",
      command,
      outputPath,
      pid,
      startedAt,
    },
    child,
  };

  // Observe exit. Process groups: child runs in its own group (detached:true
  // implies setsid), so killing -pid targets the whole group.
  child.on("error", (err) => {
    updateTaskState(id, {
      status: "error",
      endedAt: Date.now(),
      error: err.message,
    });
  });

  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    const now = Date.now();
    if (signal === "SIGKILL" || signal === "SIGTERM") {
      updateTaskState(id, {
        status: "error",
        endedAt: now,
        exitCode: code ?? -1,
        error: `Process terminated by ${signal}.`,
      });
    } else if (code === 0) {
      updateTaskState(id, { status: "done", endedAt: now, exitCode: 0 });
    } else {
      updateTaskState(id, {
        status: "error",
        endedAt: now,
        exitCode: code ?? -1,
        error: `Process exited with code ${code}.`,
      });
    }
  });

  // Detach so the event-loop doesn't keep Node alive just for this child.
  child.unref();

  registry.set(id, entry);
  return entry.state;
}

/**
 * Merge a partial update into a task's state. Enforces the discriminated-union
 * shape by rebuilding the full state object. Returns the updated state, or
 * undefined if the task is unknown.
 */
export function updateTaskState(
  id: string,
  patch: Partial<Omit<TaskState, "id" | "type" | "command" | "outputPath" | "startedAt" | "pid">>,
): TaskState | undefined {
  const entry = registry.get(id);
  if (!entry) return undefined;

  // Clear the child reference once we reach a terminal state so the process
  // can be GC'd and subsequent kill() calls short-circuit.
  if (patch.status !== undefined && isTerminalTaskStatus(patch.status)) {
    entry.child = undefined;
  }

  entry.state = { ...entry.state, ...patch } as TaskState;
  return entry.state;
}

/** Get a task's current state by id. */
export function getTask(id: string): TaskState | undefined {
  return registry.get(id)?.state;
}

/** List all known background tasks, newest-last. */
export function listTasks(): TaskState[] {
  return Array.from(registry.values()).map((e) => e.state);
}

// ─── Output log helpers ──────────────────────────────────────────────────────

export interface TaskTail {
  /** Full or tail of the output file (may be truncated). */
  output: string;
  /** Total bytes available on disk (before truncation). */
  totalBytes: number;
  /** True if the returned output was truncated from a larger file. */
  truncated: boolean;
}

/**
 * Read the tail of a task's output log. Returns up to `maxBytes` of the most
 * recent output. When the file is larger than `maxBytes`, only the tail is
 * returned (with a leading notice) to keep tool results bounded.
 */
export function readTaskOutput(id: string, maxBytes = 50_000): TaskTail | undefined {
  const task = registry.get(id)?.state;
  if (!task) return undefined;

  return readOutputPath(task.outputPath, maxBytes);
}

/** Read a tail from an explicit output path (used for unknown/orphan ids). */
export function readOutputPath(outputPath: string, maxBytes = 50_000): TaskTail {
  let totalBytes = 0;
  try {
    totalBytes = statSync(outputPath).size;
  } catch {
    return { output: "", totalBytes: 0, truncated: false };
  }

  if (totalBytes <= maxBytes) {
    let content = "";
    try {
      content = readFileSync(outputPath, "utf-8");
    } catch {
      content = "";
    }
    return { output: content, totalBytes, truncated: false };
  }

  // Read only the tail to avoid loading a multi-GB log into memory.
  const buf = Buffer.alloc(maxBytes);
  const fd = openSync(outputPath, "r");
  try {
    readSync(fd, buf, 0, maxBytes, totalBytes - maxBytes);
  } finally {
    closeSync(fd);
  }
  let tail = buf.toString("utf-8");
  // Drop a possible partial leading line.
  const firstNewline = tail.indexOf("\n");
  if (firstNewline > 0) tail = tail.slice(firstNewline + 1);
  return {
    output: `… (older output truncated; showing last ${maxBytes} bytes)\n${tail}`,
    totalBytes,
    truncated: true,
  };
}

// ─── Kill ────────────────────────────────────────────────────────────────────

export interface KillResult {
  id: string;
  killed: boolean;
  message: string;
}

/**
 * Kill a background task by signaling its process group. On Unix, the detached
 * child leads its own group, so signaling -pid reaches the whole tree. No-op
 * (and returns killed:false) if the task is already in a terminal state or
 * unknown.
 */
export function killTask(id: string): KillResult {
  const entry = registry.get(id);
  if (!entry) {
    return { id, killed: false, message: `No background task with id '${id}'.` };
  }

  const { state, child } = entry;
  if (isTerminalTaskStatus(state.status)) {
    return {
      id,
      killed: false,
      message: `Task '${id}' is not running (status: ${state.status}).`,
    };
  }
  if (!child || state.pid === undefined) {
    updateTaskState(id, {
      status: "error",
      endedAt: Date.now(),
      error: "No live process to kill.",
    });
    return { id, killed: false, message: `Task '${id}' has no live process.` };
  }

  try {
    // Signal the whole process group (negative pid). Fall back to the child
    // pid alone if process-group kill throws (e.g. already reaped).
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } catch (error) {
    return {
      id,
      killed: false,
      message: `Failed to kill task '${id}': ${(error as Error).message}`,
    };
  }

  // Escalate to SIGKILL after a short grace period if still running. The close
  // handler transitions the state to a terminal status either way.
  const pid = state.pid;
  setTimeout(() => {
    const current = registry.get(id)?.state;
    if (current && !isTerminalTaskStatus(current.status)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 2000).unref();

  return {
    id,
    killed: true,
    message: `Sent SIGTERM to task '${id}' (pid ${pid}); will escalate to SIGKILL if still running in 2s.`,
  };
}

// ─── Helpers for the TUI ─────────────────────────────────────────────────────

/** True if there is at least one task still running. */
export function hasRunningTasks(): boolean {
  for (const entry of registry.values()) {
    if (!isTerminalTaskStatus(entry.state.status)) return true;
  }
  return false;
}

/** Count tasks by status (for the status bar / tasks viewer). */
export function countTasksByStatus(): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { running: 0, done: 0, error: 0 };
  for (const entry of registry.values()) {
    counts[entry.state.status]++;
  }
  return counts;
}
