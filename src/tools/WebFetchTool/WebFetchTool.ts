




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
      // Wire the user abort in (fetch() alone would ignore the cancel and
      // keep downloading in the background).
      const signal = _context.abortController?.signal;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort);
      const timeout = AbortSignal.timeout(30_000);
      const combined = typeof AbortSignal.any === "function" ? AbortSignal.any([controller.signal, timeout]) : controller.signal;
      let response: Response;
      try {
        response = await fetch(args.url, {
          signal: combined,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; DeepSeekCode/1.0; +https://deepseek.com)",
            Accept: "text/html,application/xhtml+xml,text/plain,*/*",
          },
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }

      if (!response.ok) {
        return {
          data: `HTTP ${response.status} ${response.statusText} for ${args.url}`,
        };
      }

      // Stream the body with a hard cap instead of buffering an arbitrarily
      // large page before truncating to 50KB.
      const contentType = response.headers.get("content-type") ?? "";
      let text = "";
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.length > MAX_SIZE_CHARS) {
            text = text.slice(0, MAX_SIZE_CHARS) + "\n\n... (truncated at 50KB)";
            await reader.cancel().catch(() => {});
            break;
          }
        }
        text += decoder.decode();
      } else {
        text = await response.text();
      }

      
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
