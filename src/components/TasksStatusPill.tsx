
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import { listTasks } from "../services/tasks/backgroundFramework.js";
import { taskEntryLabel, taskTypeDotColor } from "../utils/taskLabels.js";
import { agentColorToThemeToken } from "../services/agents/agentColorManager.js";
import { colorForAgent } from "../services/teams/teamService.js";
import type { TaskState } from "../Task.js";

/**
 * Live footer pill above the prompt (Claude Code BackgroundTaskStatus
 * equivalent): lists running background agents / workflows / shells and hints
 * that ↓ opens the tasks manager. Agent dots take their team color when one
 * is assigned. Renders nothing when all tasks are idle.
 */

/** Teammate color for agent/workflow tasks, else the type's default dot. */
function dotTokenFor(task: TaskState): string {
  if (task.name) {
    const token = agentColorToThemeToken(colorForAgent(task.name));
    if (token) return token;
  }
  return taskTypeDotColor(task.type);
}

function themeToken(token: string): string {
  const value = (theme as Record<string, unknown>)[token];
  return typeof value === "string" ? value : theme.success;
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

  const shown = running.slice(0, 3);
  const more = running.length - shown.length;

  return (
    <Box paddingLeft={2}>
      <Text dimColor>
        {shown.map((task, i) => (
          <Text key={task.id}>
            {i > 0 && "  "}
            <Text color={resolveColor(themeToken(dotTokenFor(task)))}>● </Text>
            {taskEntryLabel(task.command)}
          </Text>
        ))}
        {more > 0 && `  +${more} more`}
        {"  · "}
        <Text bold>↓</Text> to view
      </Text>
    </Box>
  );
}
