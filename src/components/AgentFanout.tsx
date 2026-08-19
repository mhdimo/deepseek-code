
import React from "react";
import { Box, Text } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import type { ToolUseBlock } from "../types/index.js";

/**
 * Grouped display for a run of consecutive Agent tool blocks — the Claude
 * Code parallel-agent tree:
 *
 *   ● Running 3 agents…
 *   ├─ Explore (map the architecture) · 2 tool uses
 *   │  ⎿ Read src/index.ts
 *   ├─ Explore (find constraints) · Initializing…
 *   └─ code (implement) · Done (12 tool uses · 1m 02s)
 *      ⎿ Done
 *
 * Pure function of the blocks; MessageView uses agentFanoutLineCount() for its
 * row accounting and renders <AgentFanout> for the visuals.
 */

export interface FanoutLine {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

function agentTypeOf(block: ToolUseBlock): string {
  try {
    const parsed = block.argsJson ? JSON.parse(block.argsJson) : null;
    const t = parsed && typeof parsed === "object" ? (parsed as { subagent_type?: unknown }).subagent_type : null;
    return typeof t === "string" && t ? t : "agent";
  } catch {
    return "agent";
  }
}

/** Stats parsed from the block's own output: "⎿ Tool" activity lines plus the
 *  "Done (N tool uses · M tokens · duration)" summary line AgentTool writes. */
function statsOf(block: ToolUseBlock): { toolUses: number | null; lastActivity: string | null; doneSummary: string | null } {
  const out = block.output || "";
  let toolUses: number | null = null;
  let lastActivity: string | null = null;
  let doneSummary: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("⎿ ")) lastActivity = line.slice(2).trim();
    const m = line.match(/^Done \((\d+) tool uses?(?: · ([\d,]+) tokens)? · ([^)]+)\)$/);
    if (m) {
      toolUses = Number(m[1]);
      doneSummary = `${m[1]} tool use${m[1] === "1" ? "" : "s"}${m[2] ? ` · ${m[2]} tokens` : ""} · ${m[3]}`;
    }
  }
  return { toolUses, lastActivity, doneSummary };
}

function descriptionOf(block: ToolUseBlock): string {
  const input = block.input || "";
  return input.length > 60 ? `${input.slice(0, 59)}…` : input;
}

export function buildAgentFanoutLines(blocks: ToolUseBlock[]): FanoutLine[] {
  const lines: FanoutLine[] = [];
  const running = blocks.some((b) => b.status === "running");
  lines.push({
    text: running ? `● Running ${blocks.length} agents…` : `● ${blocks.length} agent${blocks.length === 1 ? "" : "s"} finished`,
    color: running ? resolveColor(theme.claude) : undefined,
    dim: !running,
  });

  blocks.forEach((block, i) => {
    const isLast = i === blocks.length - 1;
    const tree = isLast ? "└─" : "├─";
    const cont = isLast ? "   " : "│  ";
    const type = agentTypeOf(block);
    const { toolUses, lastActivity, doneSummary } = statsOf(block);
    const isDone = block.status === "done";
    const isError = block.status === "error";

    const tail = isError
      ? " · failed"
      : isDone
        ? (doneSummary ? ` · ${doneSummary}` : "")
        : toolUses !== null && toolUses > 0
          ? ` · ${toolUses} tool use${toolUses === 1 ? "" : "s"}`
          : "";

    lines.push({
      text: `${tree} ${type} (${descriptionOf(block)})${tail}`,
      color: isError ? resolveColor(theme.error) : undefined,
      bold: block.status === "running",
    });

    lines.push({
      text: `${cont} ⎿ ${isError ? (block.output || "error").split("\n").pop() ?? "error" : isDone ? "Done" : (lastActivity ?? "Initializing…")}`,
      dim: true,
    });

    if (block.isExpanded) {
      // Full expansion — the agent's whole chat (reference parity: opening
      // an agent block shows its complete output, not a preview).
      const outLines = (block.output || "").replace(/\n+$/, "").split("\n");
      for (const out of outLines) {
        lines.push({ text: `${cont}   ${out === "" ? " " : out}`, dim: true });
      }
    }
  });

  return lines;
}

export function agentFanoutLineCount(blocks: ToolUseBlock[]): number {
  return buildAgentFanoutLines(blocks).length;
}

export function AgentFanout({ blocks, lines: linesProp }: {
  blocks: ToolUseBlock[];
  /** Precomputed lines (MessageView computes them once for both the row
   *  accounting and the render — building them twice per render meant two
   *  JSON.parse + full-output scans of every agent block per flush). */
  lines?: FanoutLine[];
}): React.ReactElement {
  const lines = linesProp ?? buildAgentFanoutLines(blocks);
  return (
    <Box flexDirection="column" flexShrink={0} minWidth={0}>
      {lines.map((line, i) => (
        <Box key={i} height={1} flexShrink={0}>
          <Text color={line.color} bold={line.bold} dimColor={line.dim} wrap="truncate-end">
            {line.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export default AgentFanout;
