import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import type { TodoItem } from "../types/index.js";
import { listTasks } from "../services/tasks/backgroundFramework.js";
import { runningTaskActivity } from "../utils/taskLabels.js";
import { agentColorToThemeToken } from "../services/agents/agentColorManager.js";
import { colorForAgent } from "../services/teams/teamService.js";

/**
 * Claude Code TaskListV2 port — the live todo list rendering:
 *
 *   ✓ done items (green tick, strikethrough)
 *   ▪ in-progress (bold, claude accent)
 *   ▫ pending (dim square)
 *
 * In-progress items owned by a running background agent/workflow get a dim
 * activity line; blocked items show "› blocked by #2, #5" (TaskStore items).
 * Long lists truncate by terminal height with a " … +N pending, M completed"
 * summary. Rendered in the transcript under the spinner during streaming,
 * and standalone (with a counts header) in the expanded ↓ panel.
 */

const RECENT_COMPLETED_TTL_MS = 30_000;

/** Structural view used for rendering + the pure helpers below. */
export interface TaskListViewItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: string[];
  owner?: string;
}

/** TodoWrite items carry no ids or blockers — map them positionally. */
export function todosToViewItems(todos: TodoItem[]): TaskListViewItem[] {
  return todos.map((t, i) => ({
    id: String(i + 1),
    subject: t.content,
    status: t.status,
    blockedBy: [],
  }));
}

export interface TaskListV2Props {
  todos: TodoItem[];
  isStandalone?: boolean;
}

export function computeMaxDisplay(rows: number): number {
  return rows <= 10 ? 0 : Math.min(10, Math.max(3, rows - 14));
}

export function sortTasksByIdAsc(tasks: TaskListViewItem[]): TaskListViewItem[] {
  return [...tasks].sort((a, b) => {
    const aNum = parseInt(a.id, 10);
    const bNum = parseInt(b.id, 10);
    if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
    return a.id.localeCompare(b.id);
  });
}

/** Truncation priority (reference behavior — applies only when the list
 *  overflows maxDisplay): recently completed (30s TTL) → in-progress →
 *  pending (unblocked first) → older completed. When everything fits, the
 *  list is simply id-sorted. */
export function partitionTasksForDisplay(
  tasks: TaskListViewItem[],
  maxDisplay: number,
  now: number,
  completionTimestamps: Map<string, number>,
): { visible: TaskListViewItem[]; hidden: TaskListViewItem[] } {
  if (tasks.length <= maxDisplay) {
    return { visible: sortTasksByIdAsc(tasks), hidden: [] };
  }
  const unresolvedIds = new Set(
    tasks.filter((t) => t.status !== "completed").map((t) => t.id),
  );
  const recentCompleted: TaskListViewItem[] = [];
  const olderCompleted: TaskListViewItem[] = [];
  for (const task of tasks.filter((t) => t.status === "completed")) {
    const ts = completionTimestamps.get(task.id);
    if (ts && now - ts < RECENT_COMPLETED_TTL_MS) recentCompleted.push(task);
    else olderCompleted.push(task);
  }
  recentCompleted.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  olderCompleted.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  const inProgress = sortTasksByIdAsc(
    tasks.filter((t) => t.status === "in_progress"),
  );
  const pending = sortTasksByIdAsc(
    tasks.filter((t) => t.status === "pending"),
  ).sort((a, b) => {
    const aBlocked = a.blockedBy.some((id) => unresolvedIds.has(id));
    const bBlocked = b.blockedBy.some((id) => unresolvedIds.has(id));
    if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
    return 0; // stable — pre-sorted by id
  });
  const prioritized = [
    ...recentCompleted,
    ...inProgress,
    ...pending,
    ...olderCompleted,
  ];
  return {
    visible: prioritized.slice(0, maxDisplay),
    hidden: prioritized.slice(maxDisplay),
  };
}

export function summarizeHiddenTasks(hidden: TaskListViewItem[]): string {
  if (hidden.length === 0) return "";
  const parts: string[] = [];
  const inProgress = hidden.filter((t) => t.status === "in_progress").length;
  const pending = hidden.filter((t) => t.status === "pending").length;
  const completed = hidden.filter((t) => t.status === "completed").length;
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (completed > 0) parts.push(`${completed} completed`);
  return ` … +${parts.join(", ")}`;
}

export function getTaskIcon(status: TaskListViewItem["status"]): {
  icon: string;
  colorToken: "success" | "claude" | undefined;
} {
  switch (status) {
    case "completed":
      return { icon: "✓", colorToken: "success" };
    case "in_progress":
      return { icon: "▪", colorToken: "claude" };
    case "pending":
      return { icon: "▫", colorToken: undefined };
  }
}

function truncateToWidth(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(1, width - 1))}…`;
}

interface TaskItemRowProps {
  task: TaskListViewItem;
  openBlockers: string[];
  activity?: string;
  ownerActive: boolean;
  columns: number;
}

function TaskItemRow({
  task,
  openBlockers,
  activity,
  ownerActive,
  columns,
}: TaskItemRowProps): React.ReactElement {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";
  const isBlocked = openBlockers.length > 0;
  const { icon, colorToken } = getTaskIcon(task.status);

  const showActivity = isInProgress && !isBlocked && !!activity;
  const showOwner = columns >= 60 && !!task.owner && ownerActive;
  const ownerWidth = showOwner ? ` (@${task.owner})`.length : 0;
  const maxSubjectWidth = Math.max(15, columns - 15 - ownerWidth);
  const displaySubject = truncateToWidth(task.subject, maxSubjectWidth);
  const maxActivityWidth = Math.max(15, columns - 15);
  const displayActivity = activity
    ? truncateToWidth(activity, maxActivityWidth)
    : undefined;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colorToken ? resolveColor(theme[colorToken]) : undefined}>
          {icon}{" "}
        </Text>
        <Text
          bold={isInProgress}
          strikethrough={isCompleted}
          dimColor={isCompleted || isBlocked}
        >
          {displaySubject}
        </Text>
        {showOwner && (
          <Text dimColor>
            {" ("}
            <Text color={resolveColor(theme[agentColorToThemeToken(colorForAgent(task.owner!)) ?? "claude"])}>@{task.owner}</Text>
            {")"}
          </Text>
        )}
        {isBlocked && (
          <Text dimColor>
            {" › blocked by "}
            {openBlockers
              .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
              .map((id) => `#${id}`)
              .join(", ")}
          </Text>
        )}
      </Box>
      {showActivity && displayActivity && (
        <Box>
          <Text dimColor>{"  "}{displayActivity}…</Text>
        </Box>
      )}
    </Box>
  );
}

export function TaskListV2({ todos, isStandalone = false }: TaskListV2Props): React.ReactElement | null {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 80;
  const [, forceUpdate] = useState(0);

  const tasks = todosToViewItems(todos);

  // Track when each task was last observed transitioning to completed.
  const completionTimestampsRef = useRef(new Map<string, number>());
  const previousCompletedIdsRef = useRef<Set<string> | null>(null);
  if (previousCompletedIdsRef.current === null) {
    previousCompletedIdsRef.current = new Set(
      tasks.filter((t) => t.status === "completed").map((t) => t.id),
    );
  }
  const maxDisplay = computeMaxDisplay(rows);

  const currentCompletedIds = new Set(
    tasks.filter((t) => t.status === "completed").map((t) => t.id),
  );
  const now = Date.now();
  for (const id of currentCompletedIds) {
    if (!previousCompletedIdsRef.current.has(id)) {
      completionTimestampsRef.current.set(id, now);
    }
  }
  for (const id of completionTimestampsRef.current.keys()) {
    if (!currentCompletedIds.has(id)) completionTimestampsRef.current.delete(id);
  }
  previousCompletedIdsRef.current = currentCompletedIds;

  // Re-render when the next recent completion expires (depend on `tasks` so
  // the timer resets only when the list changes).
  useEffect(() => {
    if (completionTimestampsRef.current.size === 0) return;
    const currentNow = Date.now();
    let earliestExpiry = Infinity;
    for (const ts of completionTimestampsRef.current.values()) {
      const expiry = ts + RECENT_COMPLETED_TTL_MS;
      if (expiry > currentNow && expiry < earliestExpiry) earliestExpiry = expiry;
    }
    if (earliestExpiry === Infinity) return;
    const timer = setTimeout(
      () => forceUpdate((n: number) => n + 1),
      earliestExpiry - currentNow,
    );
    return () => clearTimeout(timer);
  }, [todos]);

  // Poll running background tasks so owner activity lines stay live.
  useEffect(() => {
    const id = setInterval(() => forceUpdate((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (tasks.length === 0) return null;

  // Owner → activity from running background agents/workflows. Matches by
  // task name or command content (covers "researcher" and "researcher@team").
  const ownerActivity = new Map<string, string>();
  const activeOwners = new Set<string>();
  for (const bg of listTasks()) {
    if (bg.status !== "running" || bg.type === "shell") continue;
    const activity = runningTaskActivity(bg);
    if (activity) {
      if (bg.name) {
        ownerActivity.set(bg.name, activity);
        activeOwners.add(bg.name);
      }
      for (const t of tasks) {
        if (t.owner && !ownerActivity.has(t.owner) && bg.command.includes(t.owner)) {
          ownerActivity.set(t.owner, activity);
          activeOwners.add(t.owner);
        }
      }
    }
  }

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const pendingCount = tasks.filter((t) => t.status === "pending").length;
  const inProgressCount = tasks.length - completedCount - pendingCount;

  const unresolvedTaskIds = new Set(
    tasks.filter((t) => t.status !== "completed").map((t) => t.id),
  );
  const { visible, hidden } = partitionTasksForDisplay(
    tasks,
    maxDisplay,
    now,
    completionTimestampsRef.current,
  );
  const hiddenSummary = summarizeHiddenTasks(hidden);

  const content = (
    <>
      {visible.map((task) => (
        <TaskItemRow
          key={task.id}
          task={task}
          openBlockers={task.blockedBy.filter((id) => unresolvedTaskIds.has(id))}
          activity={task.owner ? ownerActivity.get(task.owner) : undefined}
          ownerActive={task.owner ? activeOwners.has(task.owner) : false}
          columns={columns}
        />
      ))}
      {maxDisplay > 0 && hiddenSummary && <Text dimColor>{hiddenSummary}</Text>}
    </>
  );

  if (isStandalone) {
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        <Box>
          <Text dimColor>
            <Text bold>{tasks.length}</Text>
            {" tasks ("}
            <Text bold>{completedCount}</Text>
            {" done, "}
            {inProgressCount > 0 && (
              <>
                <Text bold>{inProgressCount}</Text>
                {" in progress, "}
              </>
            )}
            <Text bold>{pendingCount}</Text>
            {" open)"}
          </Text>
        </Box>
        {content}
      </Box>
    );
  }

  return <Box flexDirection="column">{content}</Box>;
}

export default TaskListV2;
