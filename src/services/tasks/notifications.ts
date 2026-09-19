/**
 * Task notifications: how a finished background task reaches the model.
 *
 * Starting a background task tells the model "this keeps running"; nothing
 * told it when the task *stopped*. The registry's close handler updated its own
 * state, and `AgentTool` called `context.onSystemMessage(...)`, which lands in
 * `pushSystem` — a UI-only `role: "system"` React message. History replay into
 * the engine filters to user/assistant, so nothing the model ever read
 * contained the completion. TaskOutput's own description promised the opposite
 * ("When you receive a notification that a background task completed or
 * failed"), which made the miss worse than silence: the model waited for a
 * message that was never going to arrive, and a long `npm test` that failed
 * went unnoticed until the session ended.
 *
 * So: every terminal transition enqueues one notification here, and the loop
 * drains the queue at the top of its next turn and hands it to the engine.
 * That last part is the interesting bit. The native session owns history, so
 * the only way to put a message in front of the model is to append a turn —
 * `session.addUser(text)` immediately before `session.sendStream(prompt)`.
 * The engine's `send_stream` appends the prompt as a user message too, so the
 * model sees two consecutive user turns: the notification, then the real
 * request. Consecutive same-role turns are fine on the wire (and in the
 * sliding-window strategy, which slices by turn unit and enforces no
 * alternation), and keeping them separate means the model never confuses a
 * status report for something the user said.
 *
 * Delivery is one turn late by construction — the engine's loop is native and
 * there is no hook to inject mid-turn — which is also how the reference
 * behaves for anything not explicitly monitored.
 *
 * The block format is the reference's: a `<task-notification>` element with
 * task-id, output-file, status and summary, plus result/usage for agents. The
 * markers are what make the text unambiguous when it arrives in a user turn.
 */

import type { TaskState, TaskType } from "../../Task.js";

/** "stopped" is the user's doing (TaskStop); the other two are the task's. */
export type NotificationStatus = "completed" | "failed" | "stopped";

export const MAX_SUMMARY_CHARS = 120;
export const MAX_RESULT_CHARS = 4000;
export const MAX_TAIL_CHARS = 1500;

export interface TaskNotificationUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

export interface TaskNotification {
  taskId: string;
  type: TaskType;
  status: NotificationStatus;
  /** One line: what finished, and how it ended. */
  summary: string;
  /** Where the full output lives — what the model should read next. */
  outputPath: string;
  /** Agent tasks only: the subagent's final message. */
  result?: string;
  /** Failed tasks only: the tail of the log, so the first thing the model
   *  reads is the reason rather than the shape of the failure. */
  tail?: string;
  usage?: TaskNotificationUsage;
}

/** Caller-supplied extras for a transition. Everything is optional: the
 *  registry can build a useful notification from the task state alone. */
export interface TaskNotificationDetail {
  /** Override the derived status (the kill path says "stopped"). */
  status?: NotificationStatus;
  result?: string;
  tail?: string;
  usage?: TaskNotificationUsage;
}

/** Collapse to a single line and bound the length. Summaries end up inside an
 *  XML element in a prompt, so embedded newlines would break the shape. */
export function oneLine(text: string, max = MAX_SUMMARY_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The line the model reads first. Wording follows the reference's task
 *  summaries, which are self-describing in a transcript. */
export function summarizeTask(state: TaskState, status: NotificationStatus): string {
  const subject = oneLine(state.description ?? state.name ?? state.command);
  switch (state.type) {
    case "agent":
      if (status === "completed") return `Agent "${subject}" completed`;
      if (status === "stopped") return `Agent "${subject}" was stopped`;
      return `Agent "${subject}" failed: ${oneLine(state.error ?? "unknown error")}`;
    case "workflow":
      if (status === "completed") return `Workflow "${subject}" completed`;
      if (status === "stopped") return `Workflow "${subject}" was stopped`;
      return `Workflow "${subject}" failed: ${oneLine(state.error ?? "unknown error")}`;
    default:
      if (status === "completed") return `Background command "${subject}" completed`;
      if (status === "stopped") return `Background command "${subject}" was stopped`;
      return `Background command "${subject}" failed: ${oneLine(
        state.error ?? `exit code ${state.exitCode ?? "?"}`,
      )}`;
  }
}

/** Build the notification for a task that has just reached a terminal status. */
export function notificationFor(
  state: TaskState,
  detail?: TaskNotificationDetail,
): TaskNotification | null {
  if (state.status === "running") return null;

  const status: NotificationStatus =
    detail?.status ?? (state.status === "done" ? "completed" : "failed");

  return {
    taskId: state.id,
    type: state.type,
    status,
    summary: summarizeTask(state, status),
    outputPath: state.outputPath,
    ...(detail?.result ? { result: bound(detail.result, MAX_RESULT_CHARS) } : {}),
    ...(detail?.tail ? { tail: bound(detail.tail, MAX_TAIL_CHARS) } : {}),
    ...(detail?.usage ? { usage: detail.usage } : {}),
  };
}

function bound(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n… (truncated)" : text;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** Notification per task id, awaiting the next turn. A Map (not an array) so
 *  a task that somehow reports twice collapses into one entry. */
const pending = new Map<string, TaskNotification>();

/** Task ids that have already been notified. This is the "exactly once"
 *  guarantee: a task that completes and is then killed must not send the
 *  model a second, contradictory notification. Ids are unique per task, so
 *  the set is bounded by the number of tasks the process ever ran. */
const notified = new Set<string>();

/** Enqueue a notification. Returns false when this task already notified. */
export function pushTaskNotification(notification: TaskNotification): boolean {
  if (notified.has(notification.taskId)) return false;
  notified.add(notification.taskId);
  pending.set(notification.taskId, notification);
  return true;
}

/** Everything queued, oldest first, and the queue is now empty. */
export function takeTaskNotifications(): TaskNotification[] {
  const out = Array.from(pending.values());
  pending.clear();
  return out;
}

/** Still queued — for tests and diagnostics, not for the send path. */
export function pendingTaskNotificationCount(): number {
  return pending.size;
}

export function resetTaskNotifications(): void {
  pending.clear();
  notified.clear();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatTaskNotification(n: TaskNotification): string {
  const lines = [
    "<task-notification>",
    `<task-id>${n.taskId}</task-id>`,
    `<output-file>${escapeXml(n.outputPath)}</output-file>`,
    `<status>${n.status}</status>`,
    `<summary>${escapeXml(n.summary)}</summary>`,
  ];
  if (n.result) lines.push(`<result>${escapeXml(n.result)}</result>`);
  if (n.usage) {
    lines.push(
      `<usage><total_tokens>${n.usage.totalTokens}</total_tokens>` +
        `<tool_uses>${n.usage.toolUses}</tool_uses>` +
        `<duration_ms>${n.usage.durationMs}</duration_ms></usage>`,
    );
  }
  lines.push("</task-notification>");
  if (n.tail) lines.push(`Last output:\n${n.tail}`);
  return lines.join("\n");
}

/** The text handed to the engine for a batch of notifications. Empty string
 *  when there is nothing to say — callers check before appending a turn. */
export function formatTaskNotifications(list: TaskNotification[]): string {
  if (list.length === 0) return "";
  const heading =
    list.length === 1
      ? "A background task finished since your last turn. This is a system notification, not a message from the user:"
      : `${list.length} background tasks finished since your last turn. These are system notifications, not messages from the user:`;
  const trailer =
    "Use TaskOutput with the task-id above (or the Read tool on the output file) to see the full output.";
  return `${heading}\n\n${list.map(formatTaskNotification).join("\n\n")}\n\n${trailer}`;
}
