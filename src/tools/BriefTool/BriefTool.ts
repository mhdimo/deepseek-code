// BriefTool — delivers a deliberate user-facing notification (a "brief")
//
// Distinct from casual streaming output: the brief is surfaced as a
// highlighted card in the TUI via the onToolResult hook. The model returns
// a formatted string (the rendered content) and the integrator/TUI can
// inspect the input metadata (title, status, priority) to style or route it.
//
// Read-only and concurrency-safe: it mutates no shared agent state and only
// invokes the optional onToolResult callback.

import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION, BRIEF_TOOL_NAME } from "./prompt.js";

// ─── Input schema ────────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PRIORITY_ICON: Record<NonNullable<BriefInput["priority"]>, string> = {
  normal: "•",
  high: "❗",
};

const STATUS_TAG: Record<BriefInput["status"], string> = {
  normal: "brief",
  proactive: "proactive",
};

/**
 * Render the brief into a plain-text string that is also useful as the tool
 * result returned to the model. The TUI may render its own card from the
 * input metadata passed through onToolResult; this string is the fallback /
 * transcript record.
 */
function renderBrief(input: BriefInput): string {
  const priority = input.priority ?? "normal";
  const icon = PRIORITY_ICON[priority];
  const tag = STATUS_TAG[input.status].toUpperCase();

  const header = input.title
    ? `${icon} [${tag}] ${input.title}`
    : `${icon} [${tag}]`;

  return `${header}\n\n${input.message}`;
}

// ─── Tool definition ─────────────────────────────────────────────────────────

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

  // No permission prompt — sending a message to the user is always allowed
  // and is a read-only operation with respect to the agent's environment.
  async checkPermissions() {
    return { approved: true };
  },

  async call(
    input: BriefInput,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const data = renderBrief(input);

    // Surface the brief to the TUI through the existing onToolResult hook.
    // The integrator can detect toolName === "Brief" in the handler and render
    // a highlighted card using input.title / input.status / input.priority.
    if (context.onToolResult) {
      context.onToolResult(BRIEF_TOOL_NAME, input, data, false);
    }

    return {
      data: `Brief delivered to user.\n\n${data}`,
    };
  },
}) satisfies import("../../Tool.js").Tool;
