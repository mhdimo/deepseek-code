import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { listTasks } from "../services/tasks/backgroundFramework.js";
import type { TaskState } from "../Task.js";

/**
 * Live footer pill above the prompt (Claude Code BackgroundTaskStatus +
 * pillLabel parity): a compact type-aware aggregate of running background
 * agents / workflows / shells. Reference labels: "1 local agent", "2 shells",
 * "1 background workflow", mixed sets collapse to "N background tasks".
 * Renders nothing when idle.
 *
 * The reference's " · ↓ to view" call to action only sits on the pill in the
 * two ultraplan attention states (tasks/pillLabel.ts pillNeedsCta), which this
 * app's task model has no equivalent of — so a running set renders the label
 * alone. (Claude Code's separate footer hint line shows "↓ to manage"
 * whenever a pill exists; our StatusBar has no background-task input, so that
 * line would need App wiring.)
 */

/** Aggregated label for a set of running tasks (pillLabel.ts parity). */
export function getPillLabel(tasks: TaskState[]): string {
  const n = tasks.length;
  const allSameType = tasks.every((t) => t.type === tasks[0]!.type);
  if (allSameType) {
    switch (tasks[0]!.type) {
      case "shell":
        return n === 1 ? "1 shell" : `${n} shells`;
      case "agent":
        return n === 1 ? "1 local agent" : `${n} local agents`;
      case "workflow":
        return n === 1 ? "1 background workflow" : `${n} background workflows`;
    }
  }
  return `${n} background ${n === 1 ? "task" : "tasks"}`;
}

export default function TasksStatusPill(): React.ReactNode {
  const [running, setRunning] = useState<TaskState[]>([]);

  useEffect(() => {
    // Diff against the previous snapshot: listTasks() returns a fresh array
    // every second, and a bare setRunning forced a full App-tree render +
    // Ink layout pass even when no task changed.
    const update = () => {
      const next = listTasks().filter((t) => t.status === "running");
      setRunning((prev) => {
        if (prev.length === next.length && prev.every((t, i) => t.id === next[i]?.id)) {
          return prev;
        }
        return next;
      });
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  if (running.length === 0) return null;

  return (
    <Box paddingLeft={2}>
      <Text dimColor>{getPillLabel(running)}</Text>
    </Box>
  );
}
