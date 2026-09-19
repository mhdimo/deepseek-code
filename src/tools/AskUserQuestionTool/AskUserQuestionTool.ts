




import { z } from "zod";
import {
  buildTool,
  type AskUserQuestionsResult,
  type ToolUseContext,
  type ToolResult,
} from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";
import type { AskUserQuestion } from "../../types/index.js";

//
// The two refusals, verbatim from the reference. Esc rejects outright and
// "Chat about this" rejects with a reason — the difference matters to the
// model, which has to know whether to stop or to keep the conversation going.
const TOOL_USE_REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected " +
  "(eg. if it was a file edit, the new_string was NOT written to the file).";
const REJECT_MESSAGE = `${TOOL_USE_REJECTED} STOP what you are doing and wait for the user to tell you how to proceed.`;
const REJECT_MESSAGE_WITH_REASON_PREFIX = `${TOOL_USE_REJECTED} To tell you how to proceed, the user said:\n`;

function renderAskUserResult(result: AskUserQuestionsResult): string {
  switch (result.kind) {
    case "answered": {
      const pairs = Object.entries(result.answers)
        .map(([question, answer]) => `"${question}"="${answer}"`)
        .join(", ");
      return `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`;
    }
    case "clarify":
      return REJECT_MESSAGE_WITH_REASON_PREFIX + result.feedback;
    case "cancelled":
      return REJECT_MESSAGE;
  }
}

const inputSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string().describe("The question to ask"),
      header: z.string().describe("Short header/label for the question"),
      options: z
        .array(
          z.object({
            label: z.string().describe("Option label shown to the user"),
            description: z
              .string()
              .describe("Brief description of this option"),
          }),
        )
        .describe("Available answer options"),
      multiSelect: z
        .boolean()
        .optional()
        .describe("Whether multiple options can be selected"),
    }),
  ).describe("List of questions to ask the user"),
}) satisfies z.ZodType;

export const AskUserQuestionTool = buildTool({
  name: "AskUserQuestion",
  requiredPermission: "allowRead",
  description: DESCRIPTION,
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    if (context.askUserQuestions) {
      try {
        const result = await context.askUserQuestions(
          args.questions as AskUserQuestion[],
        );
        return { data: renderAskUserResult(result) };
      } catch (error) {
        return {
          data: `Error asking questions: ${(error as Error).message}`,
        };
      }
    }


    //
    // No interactive prompt is wired up (headless runs). Fall back to the
    // permission prompt, which can still carry free-text feedback.
    const answers: Record<string, string> = {};

    for (const q of args.questions) {
      const optionsText = q.options
        .map((o) => `  - ${o.label}: ${o.description}`)
        .join("\n");
      const desc = [
        `Question: ${q.question}`,
        `Options:`,
        optionsText,
        q.multiSelect ? "(multi-select)" : "",
        "Please provide your answer as feedback.",
      ]
        .filter(Boolean)
        .join("\n");

      const decision = await context.requestPermission(
        `AskUserQuestion: ${q.header}`,
        desc,
      );

      // A refusal with nothing to say is a cancellation, not an answer.
      if (!decision.approved && !decision.feedback) {
        return { data: REJECT_MESSAGE };
      }

      // Keyed by the question text, not the header chip — the model looks its
      // answers up by the question it asked (see AskUserQuestionsResult).
      answers[q.question] = decision.feedback ?? "(no answer provided)";
    }

    return { data: renderAskUserResult({ kind: "answered", answers }) };
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => false,

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Ask ${input.questions.length} question(s)`,
}) satisfies import("../../Tool.js").Tool;
