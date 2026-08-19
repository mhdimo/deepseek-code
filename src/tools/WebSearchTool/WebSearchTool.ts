




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

async function searchDuckDuckGo(query: string, maxResults = 5): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      // A slow/blocked search endpoint must not hang the agent step.
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return `Error: HTTP ${response.status} from DuckDuckGo`;
    }
    const html = await response.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const resultBlocks = html.split('<div class="result results_links');
    
    for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
      const block = resultBlocks[i]!;
      const headingMatch = block.match(/<h2 class="result__title">[\s\S]*?<a class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const url = headingMatch?.[1] ?? "";
      let title: string = headingMatch?.[2] ?? "";

      const snippetMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      let snippet: string = snippetMatch?.[1] ?? "";

      title = title.replace(/<[^>]+>/g, "").trim();
      snippet = snippet.replace(/<[^>]+>/g, "").trim();
      
      if (url) {
        const cleanTitle = title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const cleanSnippet = snippet.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        
        let cleanUrl = url;
        if (url.includes("uddg=")) {
          const uddgMatch = url.match(/uddg=([^&]+)/);
          if (uddgMatch && uddgMatch[1]) {
            cleanUrl = decodeURIComponent(uddgMatch[1]);
          }
        }
        results.push({ title: cleanTitle, url: cleanUrl, snippet: cleanSnippet });
      }
    }
    
    if (results.length === 0) {
      return "No results found.";
    }
    return results.map((r, idx) => `[${idx + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}\n`).join("\n");
  } catch (error) {
    return `Error performing search: ${(error as Error).message}`;
  }
}

export const WebSearchTool = buildTool({
  name: "WebSearch",
  description: DESCRIPTION,
  inputSchema,

  isEnabled: () => true,

  async call(
    args: z.infer<typeof inputSchema>,
    _context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const results = await searchDuckDuckGo(args.query, args.max_results ?? 5);
    return { data: results };
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
      "WebSearch",
      `Search the web for "${_input.query}"?`,
    );
  },

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Search: ${input.query}`,
}) satisfies import("../../Tool.js").Tool;
