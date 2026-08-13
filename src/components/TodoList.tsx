





import React from "react";
import { Box, Text } from "ink";
import { theme } from "../utils/theme.js";
import type { TodoItem } from "../types/index.js";

interface TodoListProps {
  todos: TodoItem[];
  
  selectedIndex?: number;
}

const STATUS_STYLE: Record<TodoItem["status"], { icon: string; color: string }> = {
  pending: { icon: "○", color: "gray" },
  in_progress: { icon: "◉", color: "yellow" },
  completed: { icon: "✓", color: "green" },
};

export default function TodoList({ todos, selectedIndex = -1 }: TodoListProps): React.ReactElement | null {
  if (todos.length === 0) return null;

  const done = todos.filter((t) => t.status === "completed").length;
  const bar = "█".repeat(done) + "░".repeat(todos.length - done);

  return (
    <Box flexDirection="column" paddingX={2} marginTop={0} marginBottom={0}>
      <Box flexDirection="row">
        <Text dimColor bold>
          {"✓ Todos "}
        </Text>
        <Text dimColor>
          {done}/{todos.length}
        </Text>
        <Text color="gray"> {bar}</Text>
      </Box>
      {todos.map((t, i) => {
        const style = STATUS_STYLE[t.status];
        
        const label = t.status === "in_progress" ? t.activeForm || t.content : t.content;
        const isDone = t.status === "completed";
        const isActive = t.status === "in_progress";
        const isSelected = i === selectedIndex;
        return (
          <Box key={`todo-${i}`} flexDirection="row">
            <Text color={isSelected ? theme.claude : style.color}>
              {isSelected ? "› " : isActive ? "▶ " : "  "}
            </Text>
            <Text color={style.color}>{style.icon} </Text>
            <Text
              color={isDone ? "gray" : isActive ? theme.assistant : undefined}
              dimColor={isDone}
              bold={isActive || isSelected}
              wrap="wrap"
            >
              {label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
