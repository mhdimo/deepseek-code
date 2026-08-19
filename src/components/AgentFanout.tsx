import React from "react";
import { Box, Text } from "ink";
import { theme, resolveColor, type Theme } from "../utils/theme.js";
import type { ToolUseBlock } from "../types/index.js";
import { colorForAgent } from "../services/teams/teamService.js";
import { getDiscoveredAgent } from "../services/agents/agentDiscovery.js";
import { agentColorToThemeToken } from "../services/agents/agentColorManager.js";

/**
 * Grouped display for a run of consecutive Agent tool blocks — Claude Code
 * renderGroupedAgentToolUse + AgentProgressLine parity:
 *
 *   ● Running 3 agents…  (ctrl+o to expand)
 *   ├─ blue explore (map the architecture) · 2 tool uses
 *   │  ⎿ Reading src/index.ts
 *   ├─ green code (implement) · 4 tool uses
 *   │  ⎿ Done
 *   └─ 2 agents finished
 *
 * Agent types with a color (team-assigned or .claude/agents frontmatter)
 * render as colored chips, matching the reference. Pure function of the
 * blocks: MessageView uses buildAgentFanoutLines() for row accounting and
 * renders <AgentFanout lines={...}> for the visuals, so the two can never
 * disagree.
 */

export interface FanoutSegment {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
}

export interface FanoutLine {
  segments: FanoutSegment[];
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

/** Stats parsed from the block's own output: "⎿ " activity lines plus the
 *  "Done (N tool uses · M tokens · duration)" summary line AgentTool writes. */
function statsOf(block: ToolUseBlock): {
  toolUses: number | null;
  tokens: number | null;
  lastActivity: string | null;
  doneSummary: string | null;
  backgrounded: boolean;
} {
  const out = block.output || "";
  let toolUses: number | null = null;
  let tokens: number | null = null;
  let lastActivity: string | null = null;
  let doneSummary: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("⎿ ")) lastActivity = line.slice(2).trim();
    const m = line.match(/^Done \((\d+) tool uses?(?: · ([\d,]+) tokens)? · ([^)]+)\)$/);
    if (m) {
      toolUses = Number(m[1]);
      if (m[2]) tokens = Number(m[2].replace(/,/g, ""));
      doneSummary = `${m[1]} tool use${m[1] === "1" ? "" : "s"}${m[2] ? ` · ${m[2]} tokens` : ""} · ${m[3]}`;
    }
  }
  // Live tool-use count while running (one ⎿ line per tool activity).
  if (toolUses === null) {
    const live = (out.match(/^⎿ /gm) || []).length;
    if (live > 0) toolUses = live;
  }
  const backgrounded = out.startsWith("Background agent launched");
  return { toolUses, tokens, lastActivity, doneSummary, backgrounded };
}

function descriptionOf(block: ToolUseBlock): string {
  const input = block.input || "";
  return input.length > 60 ? `${input.slice(0, 59)}…` : input;
}

/** Resolved chip color for an agent type (team assignment > discovered > none). */
function chipColorFor(type: string, th: Theme): string | undefined {
  const color = colorForAgent(type) ?? getDiscoveredAgent(type)?.color;
  const token = agentColorToThemeToken(color);
  if (!token) return undefined;
  const value = th[token];
  return value ? resolveColor(value) : undefined;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function buildAgentFanoutLines(blocks: ToolUseBlock[], th?: Theme): FanoutLine[] {
  const lines: FanoutLine[] = [];
  const themeObj: Theme = th ?? (theme as Theme);
  const running = blocks.some((b) => b.status === "running");
  const allSameType = blocks.length > 0 && blocks.every((b) => agentTypeOf(b) === agentTypeOf(blocks[0]!));
  const commonType = allSameType && agentTypeOf(blocks[0]!) !== "agent" ? agentTypeOf(blocks[0]!) : null;
  const anyError = blocks.some((b) => b.status === "error");
  const allBackgrounded = blocks.length > 0 && blocks.every((b) => statsOf(b).backgrounded);

  // Header — reference renderGroupedAgentToolUse:
  //   running:     ● Running N agents…            (commonType: "3 explore agents")
  //   complete:    N agents finished / N background agents launched (↓ to view)
  const header: FanoutSegment[] = [];
  if (running) {
    header.push({ text: "● ", color: resolveColor(themeObj.claude) });
    header.push({ text: "Running " });
    header.push({ text: String(blocks.length), bold: true });
    header.push({ text: commonType ? ` ${commonType} agents…` : " agents…" });
  } else if (allBackgrounded) {
    header.push({ text: `${blocks.length} background agent${blocks.length === 1 ? "" : "s"} launched ` });
    header.push({ text: "(↓ to view)", dim: true });
  } else {
    header.push({ text: `${blocks.length} ` });
    header.push({ text: commonType ? `${commonType} agents` : "agents", bold: true });
    header.push({ text: " finished" });
  }
  if (!allBackgrounded) {
    header.push({ text: "  (ctrl+o to expand)", dim: true });
  }
  lines.push({ segments: header });

  blocks.forEach((block, i) => {
    const isLast = i === blocks.length - 1;
    const tree = isLast ? "└─" : "├─";
    const cont = isLast ? "   " : "│  ";
    const type = agentTypeOf(block);
    const { toolUses, tokens, lastActivity, doneSummary, backgrounded } = statsOf(block);
    const isDone = block.status === "done";
    const isError = block.status === "error";
    const isResolved = isDone || isError || block.status === "rejected" || block.status === "interrupted";
    const desc = descriptionOf(block);

    // Main line: tree char + type chip (or name/desc when hiding the type)
    // + " · N tool uses · M tokens" — reference AgentProgressLine.
    const segs: FanoutSegment[] = [];
    segs.push({ text: `${tree} `, dim: true });
    if (!allSameType) {
      const chip = chipColorFor(type, themeObj);
      if (chip) {
        segs.push({ text: type, bold: true, backgroundColor: chip, color: resolveColor(themeObj.inverseText) });
      } else {
        segs.push({ text: type, bold: true, color: isError ? resolveColor(themeObj.error) : undefined });
      }
      if (desc) {
        segs.push({ text: ` (${desc})`, dim: true });
      }
    } else if (desc) {
      // hideType: name/description stands in for the chip.
      segs.push({ text: desc, bold: true, color: isError ? resolveColor(themeObj.error) : undefined });
    }
    if (!backgrounded) {
      if (toolUses !== null && toolUses > 0) {
        segs.push({ text: ` · ${toolUses} tool use${toolUses === 1 ? "" : "s"}`, dim: true });
      }
      if (tokens !== null && tokens > 0) {
        segs.push({ text: ` · ${formatTokens(tokens)} tokens`, dim: true });
      }
    }
    if (isError) segs.push({ text: " · failed", color: resolveColor(themeObj.error) });
    if (isResolved) for (const s of segs) if (s.bold) s.dim = true;
    lines.push({ segments: segs });

    // Status line: "│  ⎿ <status>" — running: last activity or Initializing…;
    // backgrounded: "Running in the background"; done: "Done".
    let status: string;
    if (!isResolved) {
      status = lastActivity ?? "Initializing…";
    } else if (backgrounded) {
      status = "Running in the background";
    } else if (isError) {
      status = (block.output || "error").split("\n").pop()?.trim() || "failed";
    } else {
      status = "Done";
    }
    lines.push({
      segments: [
        { text: `${cont}⎿  `, dim: true },
        { text: status, dim: true },
      ],
    });

    if (block.isExpanded) {
      // Full expansion — the agent's whole chat (reference parity: opening
      // an agent block shows its complete output, not a preview).
      const outLines = (block.output || "").replace(/\n+$/, "").split("\n");
      for (const out of outLines) {
        lines.push({ segments: [{ text: `${cont}   ${out === "" ? " " : out}`, dim: true }] });
      }
    }
  });

  return lines;
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
          <Text wrap="truncate-end">
            {line.segments.map((seg, j) => (
              <Text
                key={j}
                color={seg.color}
                backgroundColor={seg.backgroundColor}
                bold={seg.bold}
                dimColor={seg.dim}
              >
                {seg.text}
              </Text>
            ))}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export default AgentFanout;