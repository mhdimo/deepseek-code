














import { spawn, type ChildProcess } from "child_process";
import {
  appendFileSync,
  openSync,
  closeSync,
  mkdirSync,
  readFileSync,
  readSync,
  statSync,
  existsSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { dataDir } from "../../utils/dataDir.js";
import { onExitCleanup } from "../exitCleanup.js";
import {
  generateTaskId,
  isTerminalTaskStatus,
  type TaskState,
  type TaskStatus,
  type TaskType,
} from "../../Task.js";
import {
  notificationFor,
  pushTaskNotification,
  type TaskNotificationDetail,
} from "./notifications.js";



const taskOutputDir = (): string => join(dataDir(), "task-outputs");


export function getTaskOutputDir(): string {
  return taskOutputDir();
}


export function getTaskOutputPath(id: string): string {
  return join(taskOutputDir(), `${id}.log`);
}

function ensureOutputDir(): void {
  const dir = taskOutputDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Arm the exit teardown the first time a task is registered — a run that never
 * starts one has nothing to clean up, and no reason to hold signal handlers.
 */
let exitCleanupArmed = false;
function ensureExitCleanup(): void {
  if (exitCleanupArmed) return;
  exitCleanupArmed = true;
  onExitCleanup(() => {
    killAllTasks();
  });
}




interface RegistryEntry {
  state: TaskState;

  child: ChildProcess | undefined;
  /** Virtual tasks (agents, workflows) have no child process — killing calls
   *  this hook instead (e.g. abort the agent's AbortController). */
  onKill?: () => void;
  /** Set when TaskStop (not a crash, not the exit path) killed this task, so
   *  the close handler can report "stopped" instead of a signal number. */
  killedByUser?: boolean;
}

const registry = new Map<string, RegistryEntry>();


export function registerTask(
  command: string,
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    type?: TaskType;
  },
): TaskState {
  ensureOutputDir();
  ensureExitCleanup();

  const id = generateTaskId(opts.type ?? "shell");
  const outputPath = getTaskOutputPath(id);

  
  
  
  const outFd = openSync(outputPath, "w");

  const child = spawn("sh", ["-c", command], {
    cwd: opts.cwd,
    stdio: ["ignore", outFd, outFd],
    env: { ...process.env, FORCE_COLOR: "0", ...(opts.env ?? {}) },
    detached: true,
  });

  
  try {
    closeSync(outFd);
  } catch {
    
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
      updateTaskState(
        id,
        {
          status: "error",
          endedAt: now,
          exitCode: code ?? -1,
          error: entry.killedByUser ? "Terminated by user." : `Process terminated by ${signal}.`,
        },
        entry.killedByUser ? { status: "stopped" } : undefined,
      );
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

  
  child.unref();

  registry.set(id, entry);
  return entry.state;
}


/** Register an in-process (virtual) task — agents and workflows. No child
 *  process: the caller drives the work, appends to the output file via
 *  appendTaskOutput, and provides an onKill hook for TaskStop. */
export function registerVirtualTask(
  type: TaskType,
  command: string,
  opts: {
    onKill?: () => void;
    name?: string;
    description?: string;
    prompt?: string;
  } = {},
): TaskState {
  ensureOutputDir();
  ensureExitCleanup();
  const id = generateTaskId(type);
  const outputPath = getTaskOutputPath(id);
  try {
    writeFileSync(outputPath, "", "utf-8");
  } catch {

  }

  const entry: RegistryEntry = {
    state: {
      id,
      type,
      status: "running",
      command,
      name: opts.name,
      description: opts.description,
      prompt: opts.prompt,
      outputPath,
      pid: undefined,
      startedAt: Date.now(),
    },
    child: undefined,
    onKill: opts.onKill,
  };
  registry.set(id, entry);
  return entry.state;
}

/** Append a chunk to a registered task's output file (virtual tasks' live
 *  transcript — readable via TaskOutput and the /tasks view). */
export function appendTaskOutput(id: string, text: string): void {
  const task = registry.get(id)?.state;
  if (!task) return;
  try {
    appendFileSync(task.outputPath, text, "utf-8");
  } catch {
    
  }
}

/** How much of a failed task's log rides along with its notification. Enough
 *  for a stack trace or a compiler error; the full file stays on disk. */
const NOTIFICATION_TAIL_BYTES = 4096;

export function updateTaskState(
  id: string,
  patch: Partial<Omit<TaskState, "id" | "type" | "command" | "outputPath" | "startedAt" | "pid">>,
  /** Extras for the notification this transition sends (agent result, usage,
   *  or an explicit "stopped"). See services/tasks/notifications.ts. */
  detail?: TaskNotificationDetail,
): TaskState | undefined {
  const entry = registry.get(id);
  if (!entry) return undefined;

  const wasTerminal = isTerminalTaskStatus(entry.state.status);



  if (patch.status !== undefined && isTerminalTaskStatus(patch.status)) {
    entry.child = undefined;
  }

  entry.state = { ...entry.state, ...patch } as TaskState;

  // Every terminal transition notifies the model exactly once, from this one
  // place — which is why it lives here and not at the six call sites that
  // finish a task. Pushing at the call sites is how the notification came to
  // be missing: each of them remembered to update the registry and none of
  // them remembered the model.
  if (!wasTerminal && isTerminalTaskStatus(entry.state.status)) {
    const withTail: TaskNotificationDetail = { ...detail };
    if (withTail.tail === undefined && entry.state.status === "error") {
      // A failure arrives as "Process exited with code 1", which says nothing
      // about what went wrong. The tail does, and the model is about to decide
      // whether to care.
      const { output } = readOutputPath(entry.state.outputPath, NOTIFICATION_TAIL_BYTES);
      withTail.tail = output.trim() || undefined;
    }
    const notification = notificationFor(entry.state, withTail);
    if (notification) pushTaskNotification(notification);
  }

  return entry.state;
}


export function getTask(id: string): TaskState | undefined {
  return registry.get(id)?.state;
}


export function listTasks(): TaskState[] {
  return Array.from(registry.values()).map((e) => e.state);
}



export interface TaskTail {
  
  output: string;
  
  totalBytes: number;
  
  truncated: boolean;
}


export function readTaskOutput(id: string, maxBytes = 50_000): TaskTail | undefined {
  const task = registry.get(id)?.state;
  if (!task) return undefined;

  return readOutputPath(task.outputPath, maxBytes);
}


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

  
  const buf = Buffer.alloc(maxBytes);
  const fd = openSync(outputPath, "r");
  try {
    readSync(fd, buf, 0, maxBytes, totalBytes - maxBytes);
  } finally {
    closeSync(fd);
  }
  let tail = buf.toString("utf-8");
  
  const firstNewline = tail.indexOf("\n");
  if (firstNewline > 0) tail = tail.slice(firstNewline + 1);
  return {
    output: `… (older output truncated; showing last ${maxBytes} bytes)\n${tail}`,
    totalBytes,
    truncated: true,
  };
}



export interface KillResult {
  id: string;
  killed: boolean;
  message: string;
}


/**
 * Signal a task's process group, falling back to the process itself when there
 * is no group of its own (or the group is already gone).
 */
function signalGroup(child: ChildProcess, pid: number | undefined, signal: NodeJS.Signals): void {
  try {
    if (pid === undefined) {
      child.kill(signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {

    }
  }
}


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
  // Virtual task (agent / workflow): no process to signal — invoke the
  // registered kill hook (aborts the driver) and mark it terminated.
  if (!child && entry.onKill) {
    try {
      entry.onKill();
    } catch {
      
    }
    updateTaskState(
      id,
      {
        status: "error",
        endedAt: Date.now(),
        error: "Terminated by user.",
      },
      { status: "stopped" },
    );
    return { id, killed: true, message: `Terminated task '${id}'.` };
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
    // Record the intent before signalling: the close handler cannot tell a
    // user's SIGTERM from anyone else's, and "Process terminated by SIGTERM"
    // is a worse thing to hand the model than "you stopped this".
    entry.killedByUser = true;
    signalGroup(child, state.pid, "SIGTERM");
  } catch (error) {
    entry.killedByUser = false;
    return {
      id,
      killed: false,
      message: `Failed to kill task '${id}': ${(error as Error).message}`,
    };
  }

  
  
  const pid = state.pid;
  setTimeout(() => {
    const current = registry.get(id)?.state;
    if (current && !isTerminalTaskStatus(current.status)) {
      signalGroup(child, pid, "SIGKILL");
    }
  }, 2000).unref();

  return {
    id,
    killed: true,
    message: `Sent SIGTERM to task '${id}' (pid ${pid}); will escalate to SIGKILL if still running in 2s.`,
  };
}




/**
 * Stop every live task: SIGTERM each shell's process group, invoke each virtual
 * task's kill hook. Returns how many were signalled.
 *
 * This is the exit path's kill — it gets the signal out while there is still a
 * process to send it from, and does not wait. `stopAllTasks` is the graceful
 * version, for callers that can afford to wait for the processes to die.
 */
export function killAllTasks(): number {
  let signalled = 0;

  for (const entry of registry.values()) {
    if (isTerminalTaskStatus(entry.state.status)) continue;

    if (!entry.child) {
      // Virtual task (agent / workflow): abort the driver, then mark it ended
      // so the exit path's wait loop does not sit on a task nobody is running.
      try {
        entry.onKill?.();
      } catch {

      }
      updateTaskState(entry.state.id, {
        status: "error",
        endedAt: Date.now(),
        error: "Terminated: the app is exiting.",
      });
      signalled++;
      continue;
    }

    signalGroup(entry.child, entry.state.pid, "SIGTERM");
    signalled++;
  }

  return signalled;
}


/**
 * Kill every live task and wait, briefly, for the processes to actually exit.
 *
 * The wait is the point: SIGTERM only asks, and a shell can take a moment to
 * unwind. Quitting before it does leaves exactly the orphans this prevents —
 * so the graceful exit path calls this, and SIGKILLs whatever is left when the
 * deadline passes.
 */
export async function stopAllTasks(timeoutMs = 1500): Promise<number> {
  const signalled = killAllTasks();
  if (signalled === 0) return 0;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && hasRunningTasks()) {
    await new Promise((wake) => setTimeout(wake, 25));
  }

  for (const entry of registry.values()) {
    if (isTerminalTaskStatus(entry.state.status) || !entry.child) continue;
    signalGroup(entry.child, entry.state.pid, "SIGKILL");
  }

  return signalled;
}


export function hasRunningTasks(): boolean {
  for (const entry of registry.values()) {
    if (!isTerminalTaskStatus(entry.state.status)) return true;
  }
  return false;
}


export function countTasksByStatus(): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { running: 0, done: 0, error: 0 };
  for (const entry of registry.values()) {
    counts[entry.state.status]++;
  }
  return counts;
}
