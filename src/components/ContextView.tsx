import React, { useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { Dialog } from "../ui/design-system/Dialog.js";
import { StatusIcon } from "../ui/design-system/StatusIcon.js";
import { theme, resolveColor } from "../utils/theme.js";
import { assembleSystemPromptSync } from "../constants/prompts.js";
import { getAllBaseTools } from "../tools.js";
import { listSkills } from "../skills/skillService.js";
import { listDiscoveredAgents } from "../services/agents/agentDiscovery.js";
import { agentManager } from "../services/agent/index.js";
import { AUTOCOMPACT_BUFFER_TOKENS } from "../services/contextManager.js";
import { formatTokenCount } from "../services/tokenTracker.js";
import { loadConfig } from "../utils/config.js";
import {
  buildGridRows,
  estimateSegments,
  estimateTokens,
  generateContextSuggestions,
  normalizeSegments,
} from "./contextAnalysis.js";
import type { Message, TokenBudget, MCPServerConfig } from "../types/index.js";

export interface ContextViewProps {
  /** Cumulative usage reported by the engine (authoritative totals). */
  inputTokens: number;
  outputTokens: number;
  budget: TokenBudget;
  messages: Message[];
  /** Active model, shown in the header (App state). */
  model?: string;
  /** MCP server configs (App state); falls back to the loaded config. */
  mcpServers?: Record<string, MCPServerConfig>;
  onClose: () => void;
}

/** Glyph per grid cell: filled/partial ⛁/⛀ (fullness >= 0.7), dim
 *  ⛶ free space, ⛝ reserved autocompact buffer — the reference's
 *  exact code points. */
function gridGlyph(cell: { kind: "used" | "free" | "reserved"; fullness: number }): string {
  if (cell.kind === "free") return "⛶ ";
  if (cell.kind === "reserved") return "⛝ ";
  return cell.fullness >= 0.7 ? "⛁ " : "⛀ ";
}

/**
 * Interactive /context view — the Claude Code ContextVisualization
 * equivalent: a glyph-square grid of the whole window plus a legend covering
 * EVERY context consumer (system prompt, tool definitions, MCP tools,
 * custom agents, skills, messages, autocompact buffer, free space), per-item
 * breakdowns, and actionable suggestions. Heuristic segments are normalized
 * to sum to the engine-reported total so bar, legend, and summary agree.
 */
export default function ContextView({
  inputTokens,
  outputTokens,
  budget,
  messages,
  model,
  mcpServers,
  onClose,
}: ContextViewProps): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape || _input === "q") onClose();
  });

  const max = budget.maxContextTokens;
  const usedTotal = inputTokens + outputTokens;
  const effectiveLimit = max - budget.reservedForResponse;
  const usedPct = Math.min(100, (usedTotal / max) * 100);

  const analysis = useMemo(() => {
    const servers = mcpServers ?? loadConfig().mcpServers ?? {};
    let systemPrompt = "";
    try {
      systemPrompt = assembleSystemPromptSync({
        identity: agentManager.getConfig("code").systemPrompt || "",
        cwd: process.cwd(),
        model,
      });
    } catch {
      systemPrompt = "";
    }

    const tools = getAllBaseTools().map((t) => {
      let schemaText = "";
      try {
        const schema = (t.inputSchema as { toJSONSchema?: () => unknown }).toJSONSchema?.();
        schemaText = schema ? JSON.stringify(schema) : "";
      } catch {
        schemaText = "";
      }
      return {
        name: t.name,
        description: typeof t.description === "string" ? t.description : t.name,
        schemaText,
      };
    });

    const skills = listSkills().map((s) => ({ name: s.name, description: s.description }));
    const agents = listDiscoveredAgents().map((a) => ({
      name: a.name,
      description: a.description,
      prompt: a.prompt,
    }));
    const mcpEntries = Object.entries(servers)
      .filter(([, s]) => s.enabled !== false)
      .map(([name, s]) => ({ name, command: s.command, args: s.args }));

    const raw = estimateSegments({
      systemPrompt,
      tools,
      skills,
      agents,
      mcpServers: mcpEntries,
      messages,
      maxTokens: max,
      reservedTokens: AUTOCOMPACT_BUFFER_TOKENS,
      usedTotal,
    });
    const segments = normalizeSegments(raw, usedTotal);

    // Fixed grid of glyph squares: 20x10 for 1M+ windows, 10x10 below;
    // 5 wide on narrow terminals.
    const narrow = (process.stdout.columns || 80) < 80;
    const gridWidth = max >= 1_000_000 ? (narrow ? 5 : 20) : narrow ? 5 : 10;
    const gridHeight = max >= 1_000_000 ? 10 : narrow ? 5 : 10;

    const gridRows = buildGridRows(segments, max, gridWidth, gridHeight);
    const suggestions = generateContextSuggestions(segments, messages, usedTotal, max);
    return { segments, gridRows, suggestions, skills, agents, mcpEntries };
  }, [messages, model, mcpServers, max, usedTotal]);

  const pctOf = (tokens: number) => `${((tokens / max) * 100).toFixed(1)}%`;
  const freeSegment = analysis.segments.find((s) => s.key === "free");
  const reservedSegment = analysis.segments.find((s) => s.key === "reserved");
  const legendSegments = analysis.segments.filter(
    (s) => s.key !== "free" && s.key !== "reserved" && s.tokens > 0,
  );

  const itemRow = (name: string, tokens: number) => (
    <Box key={name} marginLeft={1}>
      <Text>└ {name}: </Text>
      <Text dimColor>~{formatTokenCount(tokens)} tok</Text>
    </Box>
  );

  return (
    <Dialog
      title="Context usage"
      subtitle={`${messages.length} message${messages.length === 1 ? "" : "s"} in this session`}
      onCancel={onClose}
      footer="esc to close"
    >
      {usedTotal === 0 && messages.length === 0 ? (
        <Text dimColor>No context used yet — send a message to begin.</Text>
      ) : (
        <>
          <Text dimColor>
            {model ? `${model} · ` : ""}
            {formatTokenCount(usedTotal)}/{formatTokenCount(max)} tokens ({usedPct.toFixed(1)}%)
          </Text>

          <Box flexDirection="column" marginTop={1}>
            {analysis.gridRows.map((row, ri) => (
              <Box key={ri} flexDirection="row">
                {row.map((cell, ci) => (
                  <Text
                    key={ci}
                    color={
                      cell.kind === "free"
                        ? undefined
                        : resolveColor(theme[cell.colorToken])
                    }
                    dimColor={cell.kind === "free"}
                  >
                    {gridGlyph(cell)}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>

          <Box flexDirection="column" marginTop={1}>
            <Text dimColor italic>Estimated usage by category</Text>
            {legendSegments.map((segment) => (
              <Box key={segment.key}>
                <Text color={resolveColor(theme[segment.colorToken])}>{"⛁ "}</Text>
                <Text>{segment.label.padEnd(24)}</Text>
                <Text dimColor>
                  {`~${formatTokenCount(segment.tokens)} tokens (${pctOf(segment.tokens)})`}
                </Text>
              </Box>
            ))}
            {reservedSegment && reservedSegment.tokens > 0 && (
              <Box>
                <Text color={resolveColor(theme[reservedSegment.colorToken])}>{"⛝ "}</Text>
                <Text dimColor>
                  {`${reservedSegment.label}: ${formatTokenCount(reservedSegment.tokens)} tokens (${pctOf(reservedSegment.tokens)})`}
                </Text>
              </Box>
            )}
            {freeSegment && freeSegment.tokens > 0 && (
              <Box>
                <Text dimColor>{"⛶ "}</Text>
                <Text dimColor>
                  {`${freeSegment.label}: ${formatTokenCount(freeSegment.tokens)} tokens (${pctOf(freeSegment.tokens)})`}
                </Text>
              </Box>
            )}
          </Box>

          {analysis.skills.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Text bold>Skills</Text>
                <Text dimColor> · /skills</Text>
              </Box>
              {analysis.skills.map((s) =>
                itemRow(s.name, estimateTokens(`${s.name} ${s.description}`)),
              )}
            </Box>
          )}

          {analysis.agents.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Text bold>Custom agents</Text>
                <Text dimColor> · /agent</Text>
              </Box>
              {analysis.agents.map((a) =>
                itemRow(a.name, estimateTokens(`${a.name} ${a.description} ${a.prompt ?? ""}`)),
              )}
            </Box>
          )}

          {analysis.mcpEntries.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Text bold>MCP tools</Text>
                <Text dimColor> · /mcp</Text>
              </Box>
              {analysis.mcpEntries.map((m) =>
                itemRow(m.name, estimateTokens(`${m.name} ${m.command} ${(m.args ?? []).join(" ")}`)),
              )}
            </Box>
          )}

          {analysis.suggestions.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Suggestions</Text>
              {analysis.suggestions.map((s, i) => (
                <Box key={i} marginTop={i === 0 ? 0 : 1}>
                  <StatusIcon status={s.severity} withSpace />
                  <Text bold>{s.title}</Text>
                  {s.savingsTokens !== undefined && (
                    <Text dimColor>{" → save ~"}{formatTokenCount(s.savingsTokens)}</Text>
                  )}
                </Box>
              ))}
            </Box>
          )}

          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text bold>Used: </Text>
              {formatTokenCount(usedTotal)} / {formatTokenCount(max)} tokens ({usedPct.toFixed(1)}%)
            </Text>
            <Text dimColor>
              {formatTokenCount(effectiveLimit)} usable after reserving {formatTokenCount(budget.reservedForResponse)} for the response · native session auto-compacts near the limit, /compact forces a summary
            </Text>
            <Text dimColor>Per-category numbers are estimates scaled to the engine-reported total.</Text>
          </Box>
        </>
      )}
    </Dialog>
  );
}
