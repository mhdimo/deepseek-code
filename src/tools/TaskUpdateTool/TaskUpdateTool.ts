// TaskUpdateTool — updates fields on an existing task
//
// Supports partial updates to any task field. Setting status to "deleted"
// removes the task from the store. addBlocks/addBlockedBy merge into arrays.

import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

const inputSchema = z.object({
  taskId: z.string().describe("The ID of the task to update"),
  status: z
    .enum(["pending", "in_progress", "completed", "deleted"])
    .optional()
    .describe("New status. Use 'deleted' to remove the task."),
  subject: z.string().optional().describe("Updated subject"),
  description: z.string().optional().describe("Updated description"),
  activeForm: z.string().optional().describe("Updated present progressive form"),
  addBlocks: z
    .array(z.string())
    .optional()
    .describe("Task IDs that this task blocks (merged, not replaced)"),
  addBlockedBy: z
    .array(z.string())
    .optional()
    .describe("Task IDs that block this task (merged, not replaced)"),
  owner: z.string().optional().describe("Owner or assignee of the task"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arbitrary metadata to attach to the task"),
}) satisfies z.ZodType;

export const TaskUpdateTool = buildTool({
  name: "TaskUpdate",
  description: DESCRIPTION,
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const tasks = context.getTasks();
    const index = tasks.findIndex((t) => t.id === args.taskId);

    if (index === -1) {
      return { data: `Task #${args.taskId} not found.` };
    }

    // Handle deletion
    if (args.status === "deleted") {
      const removed = tasks.splice(index, 1)[0]!;
      context.setTasks(tasks);
      return { data: `Deleted task #${removed.id}: ${removed.subject}` };
    }

    const task = tasks[index]!;
    const now = Date.now();

    // Apply scalar updates
    if (args.subject !== undefined) task.subject = args.subject;
    if (args.description !== undefined) task.description = args.description;
    if (args.activeForm !== undefined) task.activeForm = args.activeForm;
    if (args.status !== undefined) task.status = args.status;
    if (args.owner !== undefined) task.owner = args.owner;
    if (args.metadata !== undefined) task.metadata = args.metadata;

    // Merge array fields
    if (args.addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...args.addBlocks])];
    }
    if (args.addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...args.addBlockedBy])];
    }

    task.updatedAt = now;
    context.setTasks([...tasks]);

    return {
      data: `Updated task #${task.id}: ${task.subject} [${task.status}]`,
    };
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Update task #${input.taskId}`,
}) satisfies import("../../Tool.js").Tool;
