// TodoWriteTool — replaces the entire todo list
//
// Accepts an array of todo items and replaces the current list wholesale.
// Always allowed (no user approval needed).

import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";
import type { TodoItem } from "../../types/index.js";

const inputSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string().describe("Description of the todo item"),
      status: z
        .enum(["pending", "in_progress", "completed"])
        .describe("Status of the todo item"),
      activeForm: z
        .string()
        .optional()
        .describe("Present progressive form, e.g. 'Refactoring auth module'"),
    }),
  ).describe("Complete list of todo items (replaces existing list)"),
}) satisfies z.ZodType;

export const TodoWriteTool = buildTool({
  name: "TodoWrite",
  description: DESCRIPTION,
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const todos: TodoItem[] = args.todos.map((t) => ({
      content: t.content,
      status: t.status,
      ...(t.activeForm ? { activeForm: t.activeForm } : {}),
    }));

    context.setTodos(todos);
    context.onTodosChange?.(todos);

    const summary = todos
      .map((t) => {
        const icon =
          t.status === "completed"
            ? "[x]"
            : t.status === "in_progress"
              ? "[~]"
              : "[ ]";
        return `${icon} ${t.content}`;
      })
      .join("\n");

    return {
      data: `Updated todo list (${todos.length} items):\n${summary}`,
    };
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  // Always allowed — no permission prompt
  async checkPermissions() {
    return { approved: true };
  },

  userFacingName: () => "Update todo list",
}) satisfies import("../../Tool.js").Tool;
