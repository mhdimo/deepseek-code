









import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION, BRIEF_TOOL_NAME } from "./prompt.js";



const BriefInputSchema = z.object({
  message: z
    .string()
    .min(1)
    .describe(
      "The body of the brief — the message the user will read. Supports markdown.",
    ),
  title: z
    .string()
    .optional()
    .describe(
      "Optional short headline for the brief card. Keep it to a single line.",
    ),
  status: z
    .enum(["normal", "proactive"])
    .describe(
      "'normal' when replying to something the user just said; 'proactive' when surfacing something they haven't asked for (task done, blocker hit, unsolicited status).",
    ),
  priority: z
    .enum(["normal", "high"])
    .optional()
    .describe(
      "Optional urgency. 'high' for time-sensitive or blocking items; 'normal' otherwise. Defaults to 'normal'.",
    ),
});

type BriefInput = z.infer<typeof BriefInputSchema>;



const PRIORITY_ICON: Record<NonNullable<BriefInput["priority"]>, string> = {
  normal: "•",
  high: "❗",
};

const STATUS_TAG: Record<BriefInput["status"], string> = {
  normal: "brief",
  proactive: "proactive",
};


function renderBrief(input: BriefInput): string {
  const priority = input.priority ?? "normal";
  const icon = PRIORITY_ICON[priority];
  const tag = STATUS_TAG[input.status].toUpperCase();

  const header = input.title
    ? `${icon} [${tag}] ${input.title}`
    : `${icon} [${tag}]`;

  return `${header}\n\n${input.message}`;
}



export const BriefTool = buildTool({
  name: BRIEF_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: BriefInputSchema,

  userFacingName: (input) => {
    const title = (input as Partial<BriefInput>)?.title;
    return title ? `Brief: ${title}` : "Brief";
  },

  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  
  
  async checkPermissions() {
    return { approved: true };
  },

  async call(
    input: BriefInput,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const data = renderBrief(input);

    
    
    
    if (context.onToolResult) {
      context.onToolResult(BRIEF_TOOL_NAME, input, data, false);
    }

    return {
      data: `Brief delivered to user.\n\n${data}`,
    };
  },
}) satisfies import("../../Tool.js").Tool;
