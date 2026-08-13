





import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

import { agentManager } from "../../services/agent/index.js";

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
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const subagentType = args.subagent_type;
    const agentName = subagentType === "explore" ? "plan" : subagentType === "plan" ? "plan" : "code";
    
    
    const agent = agentManager.createAgent(agentName, context.providerConfig);
    
    const toolLogs: string[] = [];
    let reply = "";
    
    
    const events = agent.run(
      args.prompt,
      [],
      context.workingDir,
      context.requestPermission,
    );
    
    for await (const ev of events) {
      if (ev.type === "text-delta") {
        reply += ev.text;
      } else if (ev.type === "tool-call-start") {
        toolLogs.push(`└─ Tool Use: ${ev.toolName}`);
      }
    }
    
    const result = [
      `Sub-agent (${subagentType}) finished.`,
      toolLogs.length > 0 ? toolLogs.join("\n") : "(no tools called)",
      "",
      "Response:",
      reply,
    ].join("\n");

    return { data: result };
  },

  isEnabled: () => true,

  isReadOnly: (input: z.infer<typeof inputSchema>) =>
    input.subagent_type === "explore" || input.subagent_type === "plan",

  isConcurrencySafe: () => false,

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Sub-agent (${input.subagent_type}): ${input.description ?? input.prompt.slice(0, 60)}`,
}) satisfies import("../../Tool.js").Tool;
