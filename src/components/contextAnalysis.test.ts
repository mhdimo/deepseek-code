import { describe, expect, test } from "bun:test";
import {
  buildGridRows,
  estimateSegments,
  generateContextSuggestions,
  normalizeSegments,
  type SegmentEstimate,
} from "./contextAnalysis.js";
import type { Message } from "../types/index.js";

function makeMessages(): Message[] {
  return [
    { role: "user", content: "hello ".repeat(25) }, // ~50 tokens
    {
      role: "assistant",
      content: "hi ".repeat(25), // ~25 tokens
      toolUse: [
        { toolName: "Read", input: "{}", output: "file content ".repeat(25) }, // ~75 tokens
      ],
    },
    {
      role: "user",
      content: "",
      toolUse: [
        { toolName: "Bash", input: "{}", output: "huge ".repeat(2000) }, // ~5000 tokens
      ],
    },
  ];
}

function baseSegments(overrides: Partial<Record<string, number>> = {}): SegmentEstimate[] {
  const segs = estimateSegments({
    systemPrompt: "system prompt ".repeat(20), // ~100 tokens
    tools: [{ name: "Read", description: "reads files", schemaText: '{"type":"object"}' }],
    skills: [{ name: "code-review", description: "review code" }],
    agents: [{ name: "planner", description: "plans", prompt: "you plan things" }],
    mcpServers: [{ name: "filesystem", command: "npx", args: ["@mcp/filesystem"] }],
    messages: makeMessages(),
    maxTokens: 1_000_000,
    reservedTokens: 13_000,
    usedTotal: 0,
  });
  for (const [key, tokens] of Object.entries(overrides)) {
    if (tokens === undefined) continue;
    const seg = segs.find((s) => s.key === key);
    if (seg) seg.tokens = tokens;
  }
  return segs;
}

describe("estimateSegments", () => {
  test("covers every context consumer with nonzero estimates", () => {
    const segs = baseSegments();
    const keys = segs.map((s) => s.key);
    expect(keys).toEqual([
      "system",
      "tools",
      "mcp",
      "agents",
      "skills",
      "user",
      "assistant",
      "toolCalls",
      "reserved",
      "free",
    ]);
    for (const s of segs) {
      expect(s.tokens).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  test("reserved buffer is the fixed autocompact headroom", () => {
    const segs = baseSegments();
    expect(segs.find((s) => s.key === "reserved")!.tokens).toBe(13_000);
  });

  test("free space accounts for used + reserved", () => {
    const segs = baseSegments();
    const free = segs.find((s) => s.key === "free")!;
    expect(free.tokens).toBe(1_000_000 - 13_000); // no engine usage yet
  });
});

describe("normalizeSegments", () => {
  test("scales heuristic segments to sum exactly to usedTotal", () => {
    const segs = baseSegments();
    const used = 40_000;
    const normalized = normalizeSegments(segs, used);
    const usedSum = normalized
      .filter((s) => s.key !== "free" && s.key !== "reserved")
      .reduce((sum, s) => sum + s.tokens, 0);
    expect(usedSum).toBe(used);
    // free/reserved untouched
    expect(normalized.find((s) => s.key === "free")!.tokens).toBe(
      segs.find((s) => s.key === "free")!.tokens,
    );
    expect(normalized.find((s) => s.key === "reserved")!.tokens).toBe(13_000);
  });

  test("largest-remainder rounding distributes the leftover", () => {
    const segs = [
      { key: "user", label: "A", tokens: 1, colorToken: "claude" },
      { key: "assistant", label: "B", tokens: 1, colorToken: "suggestion" },
      { key: "toolCalls", label: "C", tokens: 1, colorToken: "warning" },
      { key: "free", label: "Free", tokens: 5, colorToken: "inactive" },
    ] as SegmentEstimate[];
    const normalized = normalizeSegments(segs, 10);
    const scaled = normalized.filter((s) => s.key !== "free");
    expect(scaled.reduce((sum, s) => sum + s.tokens, 0)).toBe(10);
    expect(scaled.map((s) => s.tokens).sort((a, b) => b - a)).toEqual([4, 3, 3]);
  });

  test("zero usedTotal zeroes every estimated segment", () => {
    const normalized = normalizeSegments(baseSegments(), 0);
    for (const s of normalized) {
      if (s.key !== "free" && s.key !== "reserved") expect(s.tokens).toBe(0);
    }
  });

  test("empty estimates fall back to attributing everything to the first segment", () => {
    const empty = [
      { key: "system", label: "System", tokens: 0, colorToken: "promptBorder" },
      { key: "free", label: "Free", tokens: 10, colorToken: "inactive" },
    ] as SegmentEstimate[];
    const normalized = normalizeSegments(empty, 7);
    expect(normalized[0]!.tokens).toBe(7);
    expect(normalized[1]!.tokens).toBe(10);
  });
});

describe("buildGridRows", () => {
  test("fills the exact grid dimensions", () => {
    const segs = normalizeSegments(baseSegments(), 50_000);
    const rows = buildGridRows(segs, 1_000_000, 20, 10);
    expect(rows.length).toBe(10);
    expect(rows.every((r) => r.length === 20)).toBe(true);
  });

  test("partial last cell of a segment gets fractional fullness", () => {
    // One tiny segment: 0.5 squares worth of 200 → fullness 0.5
    const segs = normalizeSegments(
      [{ key: "user", label: "User", tokens: 2500, colorToken: "claude" }] as SegmentEstimate[],
      2500,
    );
    const rows = buildGridRows(segs, 1_000_000, 20, 10);
    const used = rows.flat().filter((c) => c.kind === "used");
    expect(used.length).toBe(1);
    expect(used[0]!.fullness).toBeCloseTo(0.5, 1);
  });

  test("reserved cells sit at the end after free space", () => {
    const segs = baseSegments();
    const rows = buildGridRows(segs, 1_000_000, 20, 10);
    const cells = rows.flat();
    expect(cells.filter((c) => c.kind === "reserved").length).toBeGreaterThan(0);
    const lastNonFree = cells.map((c, i) => ({ c, i })).filter((x) => x.c.kind !== "free");
    const lastIdx = lastNonFree[lastNonFree.length - 1]!.i;
    // Everything after the last non-free cell is free space
    for (let i = lastIdx + 1; i < cells.length; i++) {
      expect(cells[i]!.kind).toBe("free");
    }
  });
});

describe("generateContextSuggestions", () => {
  const max = 1_000_000;

  test("no suggestions below the minimum usage", () => {
    expect(generateContextSuggestions(baseSegments(), [], 5_000, max)).toEqual([]);
  });

  test("warns when tool calls & results dominate the window", () => {
    const segs = baseSegments({ toolCalls: 60_000, user: 10_000 });
    const used = 70_000;
    const normalized = normalizeSegments(segs, used);
    const suggestions = generateContextSuggestions(normalized, [], used, max);
    const dominance = suggestions.find((s) => s.title.startsWith("Tool calls & results"));
    expect(dominance).toBeDefined();
    expect(dominance!.severity).toBe("warning");
    const toolTokens = normalized.find((s) => s.key === "toolCalls")!.tokens;
    expect(dominance!.savingsTokens).toBe(Math.floor(toolTokens * 0.3));
  });

  test("flags oversized single-tool outputs from message history", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        toolUse: [
          { toolName: "Bash", input: "{}", output: "x".repeat(60_000) }, // 15k tokens
        ],
      },
    ] as Message[];
    const used = 30_000;
    const suggestions = generateContextSuggestions(baseSegments(), messages, used, max);
    const bash = suggestions.find((s) => s.title.startsWith("Bash output"));
    expect(bash).toBeDefined();
    expect(bash!.savingsTokens).toBe(Math.floor(15_000 * 0.5));
  });

  test("warns near capacity, sorted by savings descending", () => {
    const segs = baseSegments({ toolCalls: 800_000, user: 50_000 });
    const used = 850_000; // 85% of the window
    const normalized = normalizeSegments(segs, used);
    const suggestions = generateContextSuggestions(normalized, [], used, max);
    const capacity = suggestions.find((s) => s.title.startsWith("Context is"));
    expect(capacity).toBeDefined();
    expect(capacity!.title).toContain("85%");
    // Dominance (240k savings) sorts before capacity (no savings)
    expect(suggestions[0]!.title.startsWith("Tool calls & results")).toBe(true);
    const savings = suggestions
      .filter((s) => s.savingsTokens !== undefined)
      .map((s) => s.savingsTokens!);
    expect([...savings].sort((a, b) => b - a)).toEqual(savings);
  });
});
