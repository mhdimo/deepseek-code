
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Dialog } from "../ui/design-system/Dialog.js";
import { theme, resolveColor } from "../utils/theme.js";
import {
  listTasks,
  killTask,
} from "../services/tasks/backgroundFramework.js";
import { taskDescriptionOf } from "../utils/taskLabels.js";
import TaskDetailDialog from "./tasks/TaskDetailDialog.js";
import type { TaskState, TaskType } from "../Task.js";

export interface TasksViewProps {
  onClose: () => void;
}

/** Section header order — matches the reference dialog's category order
 *  (shells → agents → workflows), and the flattened render order is exactly
 *  the navigation order. */
const SECTION_ORDER: Array<{ type: TaskType; label: string }> = [
  { type: "shell", label: "Shells" },
  { type: "agent", label: "Local agents" },
  { type: "workflow", label: "Workflows" },
];

export interface TaskSection {
  type: TaskType;
  label: string;
  tasks: TaskState[];
}

/** Running tasks first, then most recently started. */
export function sortTasksForList(tasks: TaskState[]): TaskState[] {
  return [...tasks].sort((a, b) => {
    const aRunning = a.status === "running" ? 0 : 1;
    const bRunning = b.status === "running" ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    return b.startedAt - a.startedAt;
  });
}

/** Group sorted tasks by type in SECTION_ORDER; empty sections omitted so
 *  navigation stays dense. */
export function groupTasksByType(tasks: TaskState[]): TaskSection[] {
  const sections: TaskSection[] = [];
  for (const { type, label } of SECTION_ORDER) {
    const sectionTasks = tasks.filter((t) => t.type === type);
    if (sectionTasks.length > 0) sections.push({ type, label, tasks: sectionTasks });
  }
  return sections;
}

function formatRuntime(task: TaskState): string {
  const end = task.endedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function statusColor(status: TaskState["status"]): string {
  if (status === "running") return resolveColor(theme.success);
  if (status === "done") return resolveColor(theme.suggestion);
  return resolveColor(theme.error);
}

/**
 * Interactive /tasks (alias /bashes) view — the background task registry as a
 * manageable list (Claude Code BackgroundTasksDialog equivalent). Rows are
 * grouped by type under dim section headers, running first then newest; enter
 * opens a task's detail dialog: agents show prompt, live tool activity, counts
 * and output tail; shells/workflows show the raw tail. k kills, esc closes.
 */
export default function TasksView({ onClose }: TasksViewProps): React.ReactElement {
  const [tasks, setTasks] = useState<TaskState[]>(() => listTasks());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  const sections = useMemo(() => groupTasksByType(sortTasksForList(tasks)), [tasks]);
  // Selectable rows in render order — matches how sections are drawn below.
  const rows = useMemo(() => sections.flatMap((s) => s.tasks), [sections]);

  // Live refresh while open — running tasks flip to done/error on their own.
  useEffect(() => {
    const id = setInterval(() => setTasks(listTasks()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (selectedIndex >= rows.length && rows.length > 0) {
      setSelectedIndex(rows.length - 1);
    }
  }, [rows.length, selectedIndex]);

  const closeDetail = useCallback(() => setDetailId(null), []);

  useInput((input, key) => {
    if (key.escape || key.leftArrow || input === "q") {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(rows.length - 1, prev + 1));
      return;
    }
    if (key.return) {
      const task = rows[selectedIndex];
      if (!task) return;
      setDetailId(task.id);
      setNote(null);
      return;
    }
    if (input === "x" || input === "k") {
      const task = rows[selectedIndex];
      if (!task) return;
      const result = killTask(task.id);
      setNote(result.message);
      setTasks(listTasks());
    }
  });

  const detailTask = detailId ? tasks.find((t) => t.id === detailId) : undefined;
  if (detailId && detailTask) {
    return <TaskDetailDialog task={detailTask} onBack={closeDetail} />;
  }

  if (tasks.length === 0) {
    return (
      <Dialog
        title="Background tasks"
        onCancel={onClose}
        color="background"
        footer={
          <Text>
            <Text bold>↑↓</Text> select · <Text bold>esc</Text> close
          </Text>
        }
      >
        <Text dimColor>No tasks currently running</Text>
      </Dialog>
    );
  }

  // Reference parity: per-category running counts in the subtitle ("2 active
  // agents · 1 active shell") with bold numbers; single-section lists get no
  // section header at all.
  const runningOf = (type: TaskType) =>
    tasks.filter((t) => t.type === type && t.status === "running").length;
  const subtitleParts: React.ReactNode[] = [];
  const pushCount = (count: number, noun: string, key: string) => {
    if (count > 0) {
      subtitleParts.push(
        <Text key={key}>
          <Text bold>{count}</Text>
          {` ${count === 1 ? noun : `${noun}s`}`}
        </Text>,
      );
    }
  };
  pushCount(runningOf("agent"), "active agent", "agents");
  pushCount(runningOf("shell"), "active shell", "shells");
  pushCount(runningOf("workflow"), "active workflow", "workflows");
  const subtitle = (
    <>
      {subtitleParts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text dimColor> · </Text>}
          {part}
        </React.Fragment>
      ))}
    </>
  );

  const showHeaders = sections.length > 1;
  let rowIndex = 0;
  return (
    <Dialog
      title="Background tasks"
      subtitle={subtitleParts.length > 0 ? subtitle : undefined}
      onCancel={onClose}
      color="background"
      footer={
        <Text>
          <Text bold>↑↓</Text> select · <Text bold>enter</Text> view · <Text bold>x</Text> stop · <Text bold>esc</Text> close
        </Text>
      }
    >
      <Box flexDirection="column">
        {sections.map((section, sectionIdx) => (
          <Box key={section.type} flexDirection="column" marginTop={sectionIdx > 0 ? 1 : 0}>
            {showHeaders && (
              <Text dimColor>
                <Text bold>{`  ${section.label}`}</Text>
                {` (${section.tasks.length})`}
              </Text>
            )}
            {section.tasks.map((task) => {
              const focused = rowIndex === selectedIndex;
              rowIndex++;
              return (
                <Box key={task.id} flexDirection="column">
                  <Box>
                    <Text color={focused ? resolveColor(theme.claude) : undefined} bold={focused}>
                      {focused ? "❯ " : "  "}
                      <Text color={statusColor(task.status)}>●</Text>
                      {" "}
                    </Text>
                    <Text color={focused ? resolveColor(theme.claude) : undefined} bold={focused} wrap="truncate-end">
                      {taskDescriptionOf(task)}
                    </Text>
                    <Text dimColor>{` · ${task.status} · ${formatRuntime(task)}`}</Text>
                  </Box>
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
      {note && (
        <Box marginTop={1}>
          <Text color={resolveColor(theme.warning)}>{note}</Text>
        </Box>
      )}
    </Dialog>
  );
}
