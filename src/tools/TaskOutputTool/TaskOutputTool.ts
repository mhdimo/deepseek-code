





import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { TASK_OUTPUT_TOOL_NAME, DESCRIPTION } from "./prompt.js";
import { getTask, readOutputPath } from "../../services/tasks/backgroundFramework.js";



const DEFAULT_TAIL_BYTES = 50_000;

const TaskOutputInputSchema = z.object({
  task_id: z
    .string()
    .describe("The background task id returned by Bash(run_in_background: true)."),
  tail_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum number of trailing bytes of output to return. Default 50000. The tail is returned so the most recent output is always visible.",
    ),
});



export const TaskOutputTool = buildTool({
  name: TASK_OUTPUT_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: TaskOutputInputSchema,

  userFacingName: (input) => `Task output ${input.task_id ?? ""}`.trim(),

  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  maxResultSizeChars: 100_000,

  
  checkPermissions: async () => ({ approved: true }),

  call: async (input) => {
    const id = input.task_id;
    const maxBytes = Math.min(
      Math.max(1, input.tail_bytes ?? DEFAULT_TAIL_BYTES),
      100_000,
    );

    const task = getTask(id);
    if (!task) {
      return { data: `No background task with id '${id}'.` };
    }

    const tail = readOutputPath(task.outputPath, maxBytes);
    const output = tail.output || "(no output yet)";

    const parts: string[] = [];
    parts.push(`task_id: ${task.id}`);
    parts.push(`command: ${task.command}`);
    parts.push(`status: ${task.status}`);
    if (task.exitCode !== undefined) {
      parts.push(`exit_code: ${task.exitCode}`);
    }
    if (task.error) {
      parts.push(`error: ${task.error}`);
    }
    if (tail.truncated) {
      parts.push(`output_bytes: ${tail.totalBytes} (showing last ${maxBytes})`);
    }
    parts.push(`output:\n${output}`);

    return { data: parts.join("\n") };
  },
});
