











import { randomBytes } from "crypto";




export type TaskType = "shell" | "agent" | "workflow";

export type TaskStatus = "running" | "done" | "error";


export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "done" || status === "error";
}




export interface TaskStateBase {

  id: string;

  type: TaskType;

  status: TaskStatus;

  command: string;

  /** Virtual tasks only (agents/workflows): the agent/workflow name. */
  name?: string;
  /** Virtual tasks only: human-readable description of the work. */
  description?: string;
  /** Virtual tasks only: the prompt that launched the task. */
  prompt?: string;

  outputPath: string;
  
  pid: number | undefined;
  
  startedAt: number;
  
  endedAt?: number;
  
  exitCode?: number;
  
  error?: string;
}


export interface RunningTaskState extends TaskStateBase {
  status: "running";
  exitCode?: never;
  endedAt?: never;
  error?: never;
}


export interface DoneTaskState extends TaskStateBase {
  status: "done";
  exitCode: number;
  endedAt: number;
  error?: never;
}


export interface ErrorTaskState extends TaskStateBase {
  status: "error";
  exitCode?: number;
  endedAt: number;
  error?: string;
}


export type TaskState = RunningTaskState | DoneTaskState | ErrorTaskState;



const TASK_ID_PREFIXES: Record<TaskType, string> = {

  shell: "b",
  agent: "a",
  workflow: "w",
};




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
