// WebSearchTool — placeholder implementation for web search
//
// Disabled by default. Requires SEARCH_API_KEY configuration to enable.
// Returns a helpful message when invoked while disabled.

import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

const inputSchema = z.object({
  query: z.string().describe("The search query string"),
  max_results: z
    .number()
    .optional()
    .describe("Maximum number of results to return (default: 5)"),
}) satisfies z.ZodType;

export const WebSearchTool = buildTool({
  name: "WebSearch",
  description: DESCRIPTION,
  inputSchema,

  isEnabled: () => false,

  async call(
    _args: z.infer<typeof inputSchema>,
    _context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    return {
      data: "Web search not configured. Set SEARCH_API_KEY in config to enable web search.",
    };
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Search: ${input.query}`,
}) satisfies import("../../Tool.js").Tool;
