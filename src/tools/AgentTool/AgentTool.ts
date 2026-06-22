// AgentTool — spawns sub-agents with restricted tool sets
//
// Delegates work to a sub-agent that runs independently. The sub-agent type
// determines the available tools and permissions. This is a stub implementation
// pending full integration with the agent loop.

import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

const inputSchema = z.object({
  prompt: z.string().describe("The task prompt for the sub-agent"),
  subagent_type: z
    .enum(["explore", "plan", "code"])
    .describe("Type of sub-agent to spawn (explore, plan, or code)"),
  description: z
    .string()
    .optional()
    .describe("Short description of what the sub-agent will do"),
}) satisfies z.ZodType;

export const AgentTool = buildTool({
  name: "Agent",
  description: DESCRIPTION,
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    _context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    // Stub — full implementation will create an Agent instance and stream results.
    // For now, return a placeholder so the tool is registered and functional.
    return {
      data: [
        `Sub-agent execution (${args.subagent_type}):`,
        `Prompt: ${args.prompt}`,
        "",
        "Sub-agent execution - implement full integration in agent loop.",
        `Description: ${args.description ?? "(none)"}`,
      ].join("\n"),
    };
  },

  isEnabled: () => true,

  isReadOnly: (input: z.infer<typeof inputSchema>) =>
    input.subagent_type === "explore" || input.subagent_type === "plan",

  isConcurrencySafe: () => false,

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Sub-agent (${input.subagent_type}): ${input.description ?? input.prompt.slice(0, 60)}`,
}) satisfies import("../../Tool.js").Tool;
