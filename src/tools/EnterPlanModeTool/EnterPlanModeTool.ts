




import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

const inputSchema = z.object({}) satisfies z.ZodType;

export const EnterPlanModeTool = buildTool({
  name: "EnterPlanMode",
  description: DESCRIPTION,
  inputSchema,

  async call(
    _args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    context.setPlanMode(true);
    return {
      data: "Entered plan mode. The agent will now operate in read-only mode for analysis and planning.",
    };
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  userFacingName: () => "Enter plan mode",
}) satisfies import("../../Tool.js").Tool;
