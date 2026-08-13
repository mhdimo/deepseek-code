




import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";
import type { AskUserQuestion } from "../../types/index.js";

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
  description: DESCRIPTION,
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    
    if (context.askUserQuestions) {
      try {
        const answers = await context.askUserQuestions(
          args.questions as AskUserQuestion[],
        );
        return { data: JSON.stringify(answers, null, 2) };
      } catch (error) {
        return {
          data: `Error asking questions: ${(error as Error).message}`,
        };
      }
    }

    
    
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

      answers[q.header] = decision.feedback ?? "(no answer provided)";
    }

    return { data: JSON.stringify(answers, null, 2) };
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => false,

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Ask ${input.questions.length} question(s)`,
}) satisfies import("../../Tool.js").Tool;
