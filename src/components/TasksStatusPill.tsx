import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import { listTasks } from "../services/tasks/backgroundFramework.js";
import { taskTypeDotColor } from "../utils/taskLabels.js";
import { agentColorToThemeToken } from "../services/agents/agentColorManager.js";
import { colorForAgent } from "../services/teams/teamService.js";
import type { TaskState } from "../Task.js";

/**
 * Live footer pill above the prompt (Claude Code BackgroundTaskStatus +
 * pillLabel parity): a compact type-aware aggregate of running background
 * agents / workflows / shells, plus a ↓ hint that opens the tasks manager.
 * Reference labels: "1 local agent", "2 shells", "1 background workflow",
 * mixed sets collapse to "N background tasks". Renders nothing when idle.
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

/** Dot color: first task's team color, else its type dot. */
function dotColorFor(tasks: TaskState[]): string {
  const first = tasks[0]!;
  if (first.name) {
    const token = agentColorToThemeToken(colorForAgent(first.name));
    if (token) {
      const value = (theme as Record<string, unknown>)[token];
      if (typeof value === "string") return resolveColor(value);
    }
  }
  const t = taskTypeDotColor(first.type);
  const value = (theme as Record<string, unknown>)[t];
  return resolveColor(typeof value === "string" ? value : theme.success);
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
      <Text dimColor>
        <Text color={dotColorFor(running)}>● </Text>
        {getPillLabel(running)}
        {"  · "}
        <Text bold>↓</Text> to view
      </Text>
    </Box>
  );
}