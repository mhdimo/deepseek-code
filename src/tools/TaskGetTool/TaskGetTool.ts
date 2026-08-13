



import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

const inputSchema = z.object({
  taskId: z.string().describe("The ID of the task to retrieve"),
}) satisfies z.ZodType;

export const TaskGetTool = buildTool({
  name: "TaskGet",
  description: DESCRIPTION,
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const tasks = context.getTasks();
    const task = tasks.find((t) => t.id === args.taskId);

    if (!task) {
      return { data: `Task #${args.taskId} not found.` };
    }

    return {
      data: JSON.stringify(task, null, 2),
    };
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Get task #${input.taskId}`,
}) satisfies import("../../Tool.js").Tool;
