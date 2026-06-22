// TaskListTool — lists all tasks in the task store
//
// Read-only, concurrency-safe. Returns all tasks formatted as a summary table.

import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

const inputSchema = z.object({}) satisfies z.ZodType;

export const TaskListTool = buildTool({
  name: "TaskList",
  description: DESCRIPTION,
  inputSchema,

  async call(
    _args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const tasks = context.getTasks();

    if (tasks.length === 0) {
      return { data: "No tasks." };
    }

    const lines = tasks.map((t) => {
      const statusIcon =
        t.status === "completed"
          ? "[x]"
          : t.status === "in_progress"
            ? "[~]"
            : "[ ]";
      const active = t.activeForm ? ` (${t.activeForm})` : "";
      return `${statusIcon} #${t.id} ${t.subject}${active}`;
    });

    return {
      data: `Tasks (${tasks.length}):\n${lines.join("\n")}`,
    };
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  userFacingName: () => "List all tasks",
}) satisfies import("../../Tool.js").Tool;
