import type { Theme } from "../utils/theme.js";
import type { Message } from "../types/index.js";
import { formatTokenCount } from "../services/tokenTracker.js";

/**
 * Pure context-window analysis for the /context view: per-consumer segment
 * estimation, normalization onto the engine-reported total, the glyph-grid
 * split, and actionable suggestions. No React, no theme resolution — the
 * component owns rendering.
 */

/** Rough chars-per-token heuristic for per-category estimates. The totals
 *  row uses real engine-reported usage; only the split is estimated. */
export const CHARS_PER_TOKEN = 4;

export type SegmentKey =
  | "system"
  | "tools"
  | "mcp"
  | "agents"
  | "skills"
  | "user"
  | "assistant"
  | "toolCalls"
  | "free"
  | "reserved";

export interface SegmentEstimate {
  key: SegmentKey;
  label: string;
  /** Heuristic estimate; normalizeSegments rescales these to engine totals. */
  tokens: number;
  colorToken: keyof Theme;
}

export interface ToolDefEstimate {
  name: string;
  description: string;
  schemaText?: string;
}

export interface SkillEstimate {
  name: string;
  description: string;
}

export interface AgentEstimate {
  name: string;
  description: string;
  prompt?: string;
}

export interface McpServerEstimate {
  name: string;
  command: string;
  args?: string[];
}

export interface EstimateInput {
  /** Pre-assembled system prompt text (identity + environment + rules). */
  systemPrompt: string;
  tools: ToolDefEstimate[];
  skills: SkillEstimate[];
  agents: AgentEstimate[];
  mcpServers: McpServerEstimate[];
  messages: Message[];
  maxTokens: number;
  /** Fixed autocompact headroom the engine keeps free (e.g. 13_000). */
  reservedTokens: number;
  /** Engine-reported cumulative usage (input + output). */
  usedTotal: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Every context consumer as a segment: system prompt, tool definitions,
 *  MCP tools, custom agents, skills, then the message split, the reserved
 *  autocompact buffer, and free space. */
export function estimateSegments(input: EstimateInput): SegmentEstimate[] {
  const {
    systemPrompt,
    tools,
    skills,
    agents,
    mcpServers,
    messages,
    maxTokens,
    reservedTokens,
    usedTotal,
  } = input;

  const toolDefTokens = tools.reduce(
    (sum, t) => sum + estimateTokens(`${t.name} ${t.description} ${t.schemaText ?? ""}`),
    0,
  );
  const skillTokens = skills.reduce(
    (sum, s) => sum + estimateTokens(`${s.name} ${s.description}`),
    0,
  );
  const agentTokens = agents.reduce(
    (sum, a) => sum + estimateTokens(`${a.name} ${a.description} ${a.prompt ?? ""}`),
    0,
  );
  const mcpTokens = mcpServers.reduce(
    (sum, m) => sum + estimateTokens(`${m.name} ${m.command} ${(m.args ?? []).join(" ")}`),
    0,
  );

  const userTokens = messages
    .filter((m) => m.role === "user")
    .reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const assistantTokens = messages
    .filter((m) => m.role === "assistant")
    .reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const toolCallTokens = messages.reduce(
    (sum, m) =>
      sum +
      (m.toolUse ?? []).reduce(
        (inner, b) =>
          inner + estimateTokens(`${b.input ?? ""}`) + estimateTokens(b.output ?? ""),
        0,
      ),
    0,
  );

  const freeTokens = Math.max(0, maxTokens - usedTotal - reservedTokens);

  return [
    { key: "system", label: "System prompt", tokens: estimateTokens(systemPrompt), colorToken: "promptBorder" },
    { key: "tools", label: "Tool definitions", tokens: toolDefTokens, colorToken: "inactive" },
    { key: "mcp", label: "MCP tools", tokens: mcpTokens, colorToken: "cyan_FOR_SUBAGENTS_ONLY" },
    { key: "agents", label: "Custom agents", tokens: agentTokens, colorToken: "permission" },
    { key: "skills", label: "Skills", tokens: skillTokens, colorToken: "warning" },
    { key: "user", label: "User messages", tokens: userTokens, colorToken: "claude" },
    { key: "assistant", label: "Assistant messages", tokens: assistantTokens, colorToken: "suggestion" },
    { key: "toolCalls", label: "Tool calls & results", tokens: toolCallTokens, colorToken: "orange_FOR_SUBAGENTS_ONLY" },
    { key: "reserved", label: "Autocompact buffer", tokens: Math.max(0, reservedTokens), colorToken: "inactive" },
    { key: "free", label: "Free space", tokens: freeTokens, colorToken: "inactive" },
  ];
}

const isFixedSegment = (s: SegmentEstimate): boolean =>
  s.key === "free" || s.key === "reserved";

/** Scale the heuristic segments so they sum EXACTLY to the engine-reported
 *  usedTotal (largest-remainder rounding), keeping free/reserved untouched.
 *  Bar, legend, and summary then derive from one consistent total. */
export function normalizeSegments(
  segments: SegmentEstimate[],
  usedTotal: number,
): SegmentEstimate[] {
  const scaled = segments.filter((s) => !isFixedSegment(s));
  const estimateTotal = scaled.reduce((sum, s) => sum + s.tokens, 0);

  if (estimateTotal <= 0) {
    // Nothing estimated — attribute everything to the first consumer so the
    // sum invariant still holds.
    const first = scaled[0];
    return first
      ? segments.map((s) => (s.key === first.key ? { ...s, tokens: usedTotal } : s))
      : segments;
  }

  const scale = usedTotal / estimateTotal;
  const rawScaled = scaled.map((s) => ({ segment: s, scaled: s.tokens * scale }));

  // Largest-remainder rounding: floors first, then distribute the leftover
  // one token at a time to the segments with the biggest fractional parts.
  const floors = rawScaled.map((r) => Math.floor(r.scaled));
  let remainder = usedTotal - floors.reduce((a, b) => a + b, 0);
  const order = rawScaled
    .map((r, i) => ({ i, frac: r.scaled - Math.floor(r.scaled) }))
    .sort((a, b) => b.frac - a.frac);
  const final = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    final[i] = final[i]! + 1;
    remainder -= 1;
  }

  return segments.map((s) => {
    const i = scaled.indexOf(s);
    return i === -1 ? s : { ...s, tokens: final[i]! };
  });
}

export interface GridCell {
  kind: "used" | "free" | "reserved";
  colorToken: keyof Theme;
  /** 0-1 fill of the cell; drives the ☁/⛀ glyph threshold (>= 0.7). */
  fullness: number;
}

/** Split the segments into a fixed-width grid of glyph squares (☁/⛀ filled
 *  vs partial, ⛶ dim free space, ⛝ reserved buffer at the end). */
export function buildGridRows(
  segments: SegmentEstimate[],
  maxTokens: number,
  gridWidth: number,
  gridHeight: number,
): GridCell[][] {
  const totalSquares = gridWidth * gridHeight;

  if (maxTokens <= 0) {
    return Array.from({ length: gridHeight }, () =>
      Array.from({ length: gridWidth }, () => ({
        kind: "free" as const,
        colorToken: "inactive" as const,
        fullness: 1,
      })),
    );
  }

  const segmentCells = (s: SegmentEstimate): GridCell[] => {
    const exact = (s.tokens / maxTokens) * totalSquares;
    const whole = Math.floor(exact);
    const frac = exact - whole;
    const count = Math.max(1, Math.round(exact));
    const kind: GridCell["kind"] = s.key === "reserved" ? "reserved" : "used";
    return Array.from({ length: count }, (_, i) => ({
      kind,
      colorToken: s.colorToken,
      fullness: i === whole && frac > 0 ? frac : 1,
    }));
  };

  const reserved = segments.find((s) => s.key === "reserved");
  const reservedCount =
    reserved && reserved.tokens > 0 ? segmentCells(reserved).length : 0;

  const cells: GridCell[] = [];
  for (const s of segments) {
    if (isFixedSegment(s) || s.tokens <= 0) continue;
    for (const c of segmentCells(s)) {
      if (cells.length >= totalSquares - reservedCount) break;
      cells.push(c);
    }
  }
  while (cells.length < totalSquares - reservedCount) {
    cells.push({ kind: "free", colorToken: "inactive", fullness: 1 });
  }
  if (reserved && reserved.tokens > 0) {
    for (const c of segmentCells(reserved)) {
      if (cells.length >= totalSquares) break;
      cells.push(c);
    }
  }

  const rows: GridCell[][] = [];
  for (let i = 0; i < gridHeight; i++) {
    rows.push(cells.slice(i * gridWidth, (i + 1) * gridWidth));
  }
  return rows;
}

export interface ContextSuggestion {
  severity: "info" | "warning";
  title: string;
  /** Estimated tokens that could be saved. */
  savingsTokens?: number;
}

const NEAR_CAPACITY_PCT = 80;
const TOOL_DOMINANCE_PCT = 50;
const OVERSIZED_TOOL_TOKENS = 10_000;
const OVERSIZED_TOOL_PCT = 25;
const MIN_USAGE_FOR_SUGGESTIONS = 10_000;

/** Scan the (normalized) segment estimates and message tool outputs for
 *  actionable advice: near capacity, tool results dominating the window,
 *  and oversized single-tool outputs. Warnings first, then savings desc. */
export function generateContextSuggestions(
  segments: SegmentEstimate[],
  messages: Message[],
  usedTotal: number,
  maxTokens: number,
): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = [];
  if (usedTotal < MIN_USAGE_FOR_SUGGESTIONS) return suggestions;

  const usedPct = Math.min(100, (usedTotal / maxTokens) * 100);
  if (usedPct >= NEAR_CAPACITY_PCT) {
    suggestions.push({
      severity: "warning",
      title: `Context is ${usedPct.toFixed(0)}% full — /compact to free space`,
    });
  }

  const toolSegment = segments.find((s) => s.key === "toolCalls");
  if (toolSegment && toolSegment.tokens / usedTotal > TOOL_DOMINANCE_PCT / 100) {
    suggestions.push({
      severity: "warning",
      title: `Tool calls & results dominate the window (${Math.round((toolSegment.tokens / usedTotal) * 100)}%)`,
      savingsTokens: Math.floor(toolSegment.tokens * 0.3),
    });
  }

  const byTool = new Map<string, number>();
  for (const m of messages) {
    for (const b of m.toolUse ?? []) {
      const out = estimateTokens(b.output ?? "");
      if (out > 0) byTool.set(b.toolName, (byTool.get(b.toolName) ?? 0) + out);
    }
  }
  const offenders = [...byTool.entries()]
    .map(([name, tokens]) => ({ name, tokens }))
    .filter(
      (o) =>
        o.tokens >= OVERSIZED_TOOL_TOKENS &&
        o.tokens >= usedTotal * (OVERSIZED_TOOL_PCT / 100),
    )
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 2);
  for (const o of offenders) {
    suggestions.push({
      severity: "warning",
      title: `${o.name} output is ${formatTokenCount(o.tokens)} tokens (${Math.round((o.tokens / usedTotal) * 100)}%)`,
      savingsTokens: Math.floor(o.tokens * 0.5),
    });
  }

  suggestions.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "warning" ? -1 : 1;
    return (b.savingsTokens ?? 0) - (a.savingsTokens ?? 0);
  });
  return suggestions;
}
