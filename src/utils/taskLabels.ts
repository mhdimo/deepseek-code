import type { TaskState, TaskType } from "../Task.js";

/** Registered commands look like "agent <type>: <desc>", "workflow <name>:
 *  <args>", or a raw shell command. Strip the type prefix for a compact
 *  label (TasksStatusPill, TaskListV2 owner activity, detail dialogs). */
export function taskEntryLabel(command: string): string {
  const stripped = command.replace(/^(agent|workflow)\s+\S+\s*:?\s*/, "");
  const label = stripped.length > 0 ? stripped : command;
  return label.length > 34 ? `${label.slice(0, 33)}…` : label;
}

export function taskTypeDotColor(type: TaskType): "claude" | "suggestion" | "success" {
  const map = { agent: "claude", workflow: "suggestion", shell: "success" } as const;
  return map[type] ?? "success";
}

/** Human description of a task: explicit metadata first, else parsed from
 *  the registered command line. */
export function taskDescriptionOf(task: TaskState): string {
  if (task.description) return task.description;
  const stripped = task.command.replace(/^(agent|workflow)\s+\S+\s*:?\s*/, "");
  return stripped || task.command;
}

/** Subagent type/name for agent tasks (metadata first, else the command's
 *  type slot). */
export function taskAgentTypeOf(task: TaskState): string {
  if (task.name) return task.name;
  const m = task.command.match(/^agent\s+(\S+)/);
  return m?.[1] ?? "agent";
}

/** Activity label for an in-flight agent/workflow task — used by TaskListV2
 *  to annotate todo items owned by a running teammate. */
export function runningTaskActivity(task: TaskState): string | undefined {
  if (task.status !== "running") return undefined;
  if (task.type === "shell") return undefined;
  return taskDescriptionOf(task);
}
