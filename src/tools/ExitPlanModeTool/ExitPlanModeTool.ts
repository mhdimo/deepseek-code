// ExitPlanModeTool — exits plan mode and returns to normal execution
//
// Restores the agent's ability to write and execute, depending on permissions.

import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

const inputSchema = z.object({}) satisfies z.ZodType;

export const ExitPlanModeTool = buildTool({
  name: "ExitPlanMode",
  description: DESCRIPTION,
  inputSchema,

  async call(
    _args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    context.setPlanMode(false);
    return {
      data: "Exited plan mode. The agent can now perform read and write operations according to its permissions.",
    };
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  userFacingName: () => "Exit plan mode",
}) satisfies import("../../Tool.js").Tool;
