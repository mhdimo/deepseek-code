




import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

const inputSchema = z.object({
  subject: z.string().describe("Short summary of the task"),
  description: z.string().describe("Detailed description of the task"),
  activeForm: z
    .string()
    .optional()
    .describe("Present progressive form, e.g. 'Creating the database schema'"),
}) satisfies z.ZodType;

export const TaskCreateTool = buildTool({
  name: "TaskCreate",
  description: DESCRIPTION,
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const tasks = context.getTasks();
    const now = Date.now();

    
    const maxId = tasks.reduce(
      (max, t) => Math.max(max, parseInt(t.id, 10) || 0),
      0,
    );
    const id = String(maxId + 1);

    const task = {
      id,
      subject: args.subject,
      description: args.description,
      status: "pending" as const,
      activeForm: args.activeForm,
      blocks: [] as string[],
      blockedBy: [] as string[],
      createdAt: now,
      updatedAt: now,
    };

    context.setTasks([...tasks, task]);

    return {
      data: `Created task #${id}: ${args.subject}`,
    };
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  
  async checkPermissions() {
    return { approved: true };
  },

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Create task: ${input.subject}`,
}) satisfies import("../../Tool.js").Tool;
