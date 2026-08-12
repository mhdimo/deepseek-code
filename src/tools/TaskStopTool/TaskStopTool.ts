// TaskStopTool — kill a running background shell task
//
// Companion to Bash(run_in_background: true). Delegates to the
// background-framework registry's killTask(), which signals the task's process
// group (SIGTERM, then SIGKILL after a grace period).

import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { TASK_STOP_TOOL_NAME, DESCRIPTION } from "./prompt.js";
import { killTask } from "../../services/tasks/backgroundFramework.js";

// ─── Input schema ────────────────────────────────────────────────────────────

const TaskStopInputSchema = z.object({
  task_id: z
    .string()
    .describe("The background task id returned by Bash(run_in_background: true)."),
});

// ─── Tool definition ─────────────────────────────────────────────────────────

export const TaskStopTool = buildTool({
  name: TASK_STOP_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: TaskStopInputSchema,

  userFacingName: (input) => `Stop task ${input.task_id ?? ""}`.trim(),

  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  maxResultSizeChars: 10_000,

  // Stopping a background task the user already approved to spawn doesn't need
  // a fresh permission prompt. The original Bash permission covered it.
  checkPermissions: async (_input, context) => {
    if (!context.permissions.allowExecute) {
      return { approved: false, feedback: "Execute permission denied for this agent." };
    }
    return { approved: true };
  },

  call: async (input) => {
    const result = killTask(input.task_id);
    return { data: result.message };
  },
});
