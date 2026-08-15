














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
import { homedir } from "os";
import {
  generateTaskId,
  isTerminalTaskStatus,
  type TaskState,
  type TaskStatus,
  type TaskType,
} from "../../Task.js";



const TASK_OUTPUT_DIR = join(homedir(), ".deepseek-code", "task-outputs");


export function getTaskOutputDir(): string {
  return TASK_OUTPUT_DIR;
}


export function getTaskOutputPath(id: string): string {
  return join(TASK_OUTPUT_DIR, `${id}.log`);
}

function ensureOutputDir(): void {
  if (!existsSync(TASK_OUTPUT_DIR)) {
    mkdirSync(TASK_OUTPUT_DIR, { recursive: true });
  }
}




interface RegistryEntry {
  state: TaskState;

  child: ChildProcess | undefined;
  /** Virtual tasks (agents, workflows) have no child process — killing calls
   *  this hook instead (e.g. abort the agent's AbortController). */
  onKill?: () => void;
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

export function updateTaskState(
  id: string,
  patch: Partial<Omit<TaskState, "id" | "type" | "command" | "outputPath" | "startedAt" | "pid">>,
): TaskState | undefined {
  const entry = registry.get(id);
  if (!entry) return undefined;

  
  
  if (patch.status !== undefined && isTerminalTaskStatus(patch.status)) {
    entry.child = undefined;
  }

  entry.state = { ...entry.state, ...patch } as TaskState;
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
    updateTaskState(id, {
      status: "error",
      endedAt: Date.now(),
      error: "Terminated by user.",
    });
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
