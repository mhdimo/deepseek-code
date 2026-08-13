




import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

const MAX_SIZE_CHARS = 50_000;

const inputSchema = z.object({
  url: z.string().describe("The URL to fetch content from"),
  raw: z
    .boolean()
    .optional()
    .describe("If true, return raw text without stripping HTML tags"),
}) satisfies z.ZodType;


function htmlToText(html: string): string {
  
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  
  text = text.replace(/<[^>]+>/g, "");
  
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export const WebFetchTool = buildTool({
  name: "WebFetch",
  description: DESCRIPTION,
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    _context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    try {
      const response = await fetch(args.url, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; DeepSeekCode/1.0; +https://deepseek.com)",
          Accept: "text/html,application/xhtml+xml,text/plain,*/*",
        },
      });

      if (!response.ok) {
        return {
          data: `HTTP ${response.status} ${response.statusText} for ${args.url}`,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      let text = await response.text();

      
      if (!args.raw && (contentType.includes("html") || text.includes("<html"))) {
        text = htmlToText(text);
      }

      
      if (text.length > MAX_SIZE_CHARS) {
        text = text.slice(0, MAX_SIZE_CHARS) + "\n\n... (truncated at 50KB)";
      }

      return {
        data: `Content from ${args.url}:\n\n${text}`,
      };
    } catch (error) {
      return {
        data: `Error fetching ${args.url}: ${(error as Error).message}`,
      };
    }
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async checkPermissions(
    _input: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ) {
    if (context.permissions.allowNetwork) {
      return { approved: true };
    }
    
    
    return context.requestPermission(
      "WebFetch",
      `Fetch content from ${_input.url}?`,
    );
  },

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Fetch ${input.url}`,
  maxResultSizeChars: 60_000,
}) satisfies import("../../Tool.js").Tool;
