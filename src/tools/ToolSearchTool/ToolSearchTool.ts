// ToolSearchTool — search/discover available tools by keyword.
//
// Adapted from Claude Code's ToolSearchTool, but greatly simplified for
// DeepSeek Code: there is no tool-deferral system here (all enabled tools
// are already in the prompt), so this tool is a discovery aid rather than
// a schema-loader. It reads getToolDescriptions() from the registry and
// returns matching names + descriptions. Read-only and concurrency-safe.

import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { getToolDescriptions } from "../../tools.js";
import { TOOL_SEARCH_TOOL_NAME, DESCRIPTION } from "./prompt.js";

// ─── Input schema ────────────────────────────────────────────────────────────

const ToolSearchInputSchema = z.object({
  query: z
    .string()
    .describe(
      'Query to find tools. Use "select:<tool_name>" for direct selection (comma-separated), or keywords to search.',
    ),
  max_results: z
    .number()
    .optional()
    .describe("Maximum number of results to return (default: 5)"),
});

// ─── Name parsing ────────────────────────────────────────────────────────────

/**
 * Parse a tool name into searchable parts.
 * Handles both MCP tools (mcp__server__action) and regular tools (CamelCase).
 */
function parseToolName(name: string): { parts: string[]; full: string; isMcp: boolean } {
  // MCP tool — mcp__server__action
  if (name.startsWith("mcp__")) {
    const withoutPrefix = name.replace(/^mcp__/, "").toLowerCase();
    const parts = withoutPrefix
      .split("__")
      .flatMap((p) => p.split("_"))
      .filter(Boolean);
    return {
      parts,
      full: withoutPrefix.replace(/__/g, " ").replace(/_/g, " "),
      isMcp: true,
    };
  }

  // Regular tool — split CamelCase and underscores
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return { parts, full: parts.join(" "), isMcp: false };
}

/**
 * Escape a string for safe use inside a RegExp.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pre-compile word-boundary regexes for all search terms.
 */
function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>();
  for (const term of terms) {
    if (!patterns.has(term)) {
      patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`));
    }
  }
  return patterns;
}

// ─── Keyword search ──────────────────────────────────────────────────────────

type ToolDescription = { name: string; description: string };

/**
 * Keyword-based search over tool names and descriptions.
 *
 * Supports:
 * - Exact name match (fast path)
 * - MCP prefix matching (mcp__server)
 * - Required (+prefixed) vs optional terms
 * - Weighted scoring: name part > substring > description word-boundary
 */
function searchToolsWithKeywords(
  query: string,
  tools: ToolDescription[],
  maxResults: number,
): string[] {
  const queryLower = query.toLowerCase().trim();

  // Fast path: exact name match
  const exact = tools.find((t) => t.name.toLowerCase() === queryLower);
  if (exact) return [exact.name];

  // MCP prefix match (mcp__server)
  if (queryLower.startsWith("mcp__") && queryLower.length > 5) {
    const prefixMatches = tools
      .filter((t) => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map((t) => t.name);
    if (prefixMatches.length > 0) return prefixMatches;
  }

  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0);

  // Partition into required (+prefixed) and optional terms
  const requiredTerms: string[] = [];
  const optionalTerms: string[] = [];
  for (const term of queryTerms) {
    if (term.startsWith("+") && term.length > 1) {
      requiredTerms.push(term.slice(1));
    } else {
      optionalTerms.push(term);
    }
  }

  const allScoringTerms =
    requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms;
  const termPatterns = compileTermPatterns(allScoringTerms);

  // Pre-filter: tools matching ALL required terms in name or description
  let candidates = tools;
  if (requiredTerms.length > 0) {
    candidates = tools.filter((tool) => {
      const parsed = parseToolName(tool.name);
      const descLower = tool.description.toLowerCase();
      return requiredTerms.every((term) => {
        const pattern = termPatterns.get(term)!;
        return (
          parsed.parts.includes(term) ||
          parsed.parts.some((part) => part.includes(term)) ||
          pattern.test(descLower)
        );
      });
    });
  }

  // Score each candidate
  const scored = candidates.map((tool) => {
    const parsed = parseToolName(tool.name);
    const descLower = tool.description.toLowerCase();

    let score = 0;
    for (const term of allScoringTerms) {
      const pattern = termPatterns.get(term)!;

      // Exact name-part match (higher weight for MCP server names)
      if (parsed.parts.includes(term)) {
        score += parsed.isMcp ? 12 : 10;
      } else if (parsed.parts.some((part) => part.includes(term))) {
        score += parsed.isMcp ? 6 : 5;
      }

      // Full name fallback for edge cases
      if (parsed.full.includes(term) && score === 0) {
        score += 3;
      }

      // Description word-boundary match
      if (pattern.test(descLower)) {
        score += 2;
      }
    }

    return { name: tool.name, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((item) => item.name);
}

// ─── Output formatting ───────────────────────────────────────────────────────

function formatResults(
  matches: ToolDescription[],
  totalTools: number,
): string {
  if (matches.length === 0) {
    return `No matching tools found (searched ${totalTools} available tool${totalTools === 1 ? "" : "s"}).`;
  }

  const lines = matches.map((m) => {
    // Trim description to first line / first sentence for a concise summary.
    const firstLine = m.description.split("\n")[0] ?? "";
    const summary = firstLine.length > 160 ? firstLine.slice(0, 157) + "..." : firstLine;
    return `- ${m.name}: ${summary}`;
  });

  const header = `Found ${matches.length} matching tool${matches.length === 1 ? "" : "s"} (of ${totalTools} available):`;
  return `${header}\n${lines.join("\n")}`;
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const ToolSearchTool = buildTool({
  name: TOOL_SEARCH_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: ToolSearchInputSchema,

  userFacingName: (input) => {
    const q = input.query ?? "";
    return q ? `ToolSearch ${q}` : "ToolSearch";
  },

  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  maxResultSizeChars: 100_000,

  checkPermissions: async (_input, _context) => {
    // Discovery only — no side effects, no filesystem/network access.
    // Always allowed regardless of the agent's read/write/execute permission set.
    return { approved: true };
  },

  call: async (input, _context) => {
    const query = (input.query ?? "").trim();
    const maxResults = typeof input.max_results === "number" && input.max_results > 0
      ? Math.min(Math.floor(input.max_results), 50)
      : 5;

    if (!query) {
      return { data: "Error: query is required." };
    }

    const tools = getToolDescriptions();

    // select:<names> — direct selection (comma-separated). Unknown names are
    // silently dropped so the model still gets the ones that exist.
    const selectMatch = query.match(/^select:(.+)$/i);
    if (selectMatch) {
      const requested = selectMatch[1]!
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);

      const byName = new Map(tools.map((t) => [t.name.toLowerCase(), t]));
      const found: ToolDescription[] = [];
      for (const name of requested) {
        const hit = byName.get(name.toLowerCase());
        if (hit && !found.some((f) => f.name === hit.name)) {
          found.push(hit);
        }
      }

      return { data: formatResults(found, tools.length) };
    }

    // Keyword search
    const matchNames = new Set(searchToolsWithKeywords(query, tools, maxResults));
    const matches = tools.filter((t) => matchNames.has(t.name));
    return { data: formatResults(matches, tools.length) };
  },
});
