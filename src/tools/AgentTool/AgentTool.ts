

import { z } from "zod";
import { buildTool, type ToolUseContext, type ToolResult } from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

import { agentManager } from "../../services/agent/index.js";
import {
  registerVirtualTask,
  appendTaskOutput,
  updateTaskState,
} from "../../services/tasks/backgroundFramework.js";

const inputSchema = z.object({
  prompt: z.string().describe("The task prompt for the sub-agent"),
  subagent_type: z
    .string()
    .min(1)
    .describe("Type of sub-agent to spawn: explore, plan, code, or a custom agent name from .claude/agents/"),
  description: z
    .string()
    .optional()
    .describe("Short description of what the sub-agent will do"),
  run_in_background: z
    .boolean()
    .optional()
    .describe("Run detached as a background task (manage via /tasks, TaskOutput, TaskStop)"),
}) satisfies z.ZodType;

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Shared event drain: builds the activity log, tracks tool-use/token counts,
 *  and optionally streams each tool activity line to the running tool block
 *  (live subagent progress, Claude Code parity) or to a background task's
 *  output file (its transcript). */
interface RunAccumulator {
  activity: string[];
  reply: string;
  toolUses: number;
  tokens: number;
  error: string | null;
  durationMs: number;
}

async function drainAgent(
  events: AsyncGenerator<import("../../types/index.js").AgentEvent>,
  onActivity: (line: string) => void,
): Promise<RunAccumulator> {
  const acc: RunAccumulator = {
    activity: [],
    reply: "",
    toolUses: 0,
    tokens: 0,
    error: null,
    durationMs: 0,
  };
  const started = Date.now();
  for await (const ev of events) {
    if (ev.type === "text-delta") {
      acc.reply += ev.text;
    } else if (ev.type === "tool-call-start") {
      acc.toolUses++;
      const line = `⎿ ${ev.toolName}`;
      acc.activity.push(line);
      onActivity(`${line}\n`);
    } else if (ev.type === "finish") {
      acc.tokens = ev.usage.totalTokens;
    } else if (ev.type === "error") {
      acc.error = ev.error;
    }
  }
  acc.durationMs = Date.now() - started;
  return acc;
}

export const AgentTool = buildTool({
  name: "Agent",
  description: DESCRIPTION,
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const subagentType = args.subagent_type;
    // "explore" is an alias for the read-only plan agent; everything else
    // resolves as a built-in or a discovered .claude/agents custom agent.
    const resolvedName = subagentType === "explore" ? "plan" : subagentType;
    const resolvedConfig = agentManager.resolveConfig(resolvedName);
    if (!resolvedConfig) {
      return {
        data: `✗ Unknown sub-agent type "${subagentType}". Available: ${agentManager.listAgentNames().join(", ")}`,
      };
    }
    const agentName = resolvedConfig.name;
    const desc = args.description ?? args.prompt.slice(0, 60);

    const agent = agentManager.createAgent(agentName, context.providerConfig);
    const events = agent.run(
      args.prompt,
      [],
      context.workingDir,
      context.requestPermission,
    );

    // Background mode: register a trackable task, return immediately, and
    // drive the loop detached. The task's output file is the subagent's
    // transcript (readable via TaskOutput and the /tasks view).
    if (args.run_in_background) {
      let killed = false;
      const task = registerVirtualTask("agent", `agent ${subagentType}: ${desc}`, {
        onKill: () => {
          killed = true;
          agent.abort();
        },
        name: subagentType,
        description: desc,
        prompt: args.prompt,
      });
      void (async () => {
        appendTaskOutput(
          task.id,
          `Agent (${subagentType}): ${desc}\nprompt: ${args.prompt.slice(0, 500)}\n\n`,
        );
        const acc = await drainAgent(events, (line) => appendTaskOutput(task.id, line));
        const outcome = killed
          ? "✗ Terminated by user."
          : acc.error
            ? `✗ ${acc.error}`
            : `✓ Done (${acc.toolUses} tool uses · ${acc.tokens.toLocaleString()} tokens · ${formatDuration(acc.durationMs)})`;
        appendTaskOutput(
          task.id,
          `\n${outcome}\n\n--- response ---\n${acc.reply || "(no response)"}\n`,
        );
        if (!killed) {
          updateTaskState(
            task.id,
            acc.error
              ? { status: "error", endedAt: Date.now(), error: acc.error }
              : { status: "done", endedAt: Date.now(), exitCode: 0 },
          );
        }
        context.onSystemMessage?.(
          `${acc.error || killed ? "✗" : "✓"} Background agent "${desc}" ${killed ? "terminated" : acc.error ? `failed: ${acc.error}` : `finished (${acc.toolUses} tool uses)`} — view it with /tasks.`,
        );
      })();

      return {
        data:
          `Background agent launched (task ${task.id}).\n` +
          `Track live: /tasks or TaskOutput ${task.id}\n` +
          `Stop: TaskStop ${task.id}`,
      };
    }

    // Foreground: register the run as a task too (Claude Code parity — every
    // agent run is accessible from /tasks and the footer pill while it
    // streams), then stream each tool activity line into the running tool
    // block AND the task transcript. The summary + activity log + response
    // survive in the block for ctrl+o/ctrl+e inspection.
    let killed = false;
    const task = registerVirtualTask("agent", `agent ${subagentType}: ${desc}`, {
      onKill: () => {
        killed = true;
        agent.abort();
      },
      name: subagentType,
      description: desc,
      prompt: args.prompt,
    });
    appendTaskOutput(
      task.id,
      `Agent (${subagentType}): ${desc}\nprompt: ${args.prompt.slice(0, 500)}\n\n`,
    );
    const acc = await drainAgent(events, (line) => {
      context.onToolOutput?.("Agent", line);
      appendTaskOutput(task.id, line);
    });
    updateTaskState(
      task.id,
      killed
        ? { status: "error", endedAt: Date.now(), error: "Terminated by user." }
        : acc.error
          ? { status: "error", endedAt: Date.now(), error: acc.error }
          : { status: "done", endedAt: Date.now(), exitCode: 0 },
    );
    appendTaskOutput(
      task.id,
      `\n${killed ? "✗ Terminated by user." : acc.error ? `✗ ${acc.error}` : `Done (${acc.toolUses} tool uses · ${acc.tokens.toLocaleString()} tokens · ${formatDuration(acc.durationMs)})`}\n`,
    );

    if (acc.error) {
      return { data: `✗ Sub-agent (${subagentType}) failed: ${acc.error}` };
    }

    const summary = `Done (${acc.toolUses} tool use${acc.toolUses === 1 ? "" : "s"} · ${acc.tokens.toLocaleString()} tokens · ${formatDuration(acc.durationMs)})`;
    const result = [
      summary,
      "",
      ...acc.activity,
      acc.activity.length > 0 ? "" : null,
      "Response:",
      acc.reply || "(no response)",
    ]
      .filter((part) => part !== null)
      .join("\n");

    return { data: result };
  },

  isEnabled: () => true,

  isReadOnly: (input: z.infer<typeof inputSchema>) => {
    const resolvedName = input.subagent_type === "explore" ? "plan" : input.subagent_type;
    const config = agentManager.resolveConfig(resolvedName);
    if (config) return !config.permissions.allowWrite && !config.permissions.allowExecute;
    return input.subagent_type === "plan";
  },

  isConcurrencySafe: () => true,

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Sub-agent (${input.subagent_type}): ${input.description ?? input.prompt.slice(0, 60)}`,
}) satisfies import("../../Tool.js").Tool;
