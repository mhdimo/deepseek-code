

import { z } from "zod";
import {
  buildTool,
  type PermissionDecision,
  type ToolUseContext,
  type ToolResult,
} from "../../Tool.js";
import { DESCRIPTION } from "./prompt.js";

import { agentManager } from "../../services/agent/index.js";
import { describeToolActivity } from "../../utils/toolUtils.js";
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

/** "explore" is an alias for the read-only plan agent; everything else resolves
 *  as a built-in or a discovered `.claude/agents` custom agent. Used by the
 *  call, the read-only check and the capability check — all three have to agree
 *  on which agent a name refers to. */
function resolveSubagent(subagentType: string) {
  const resolvedName = subagentType === "explore" ? "plan" : subagentType;
  return agentManager.resolveConfig(resolvedName);
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

interface ActivityCallbackRef {
  current?: (toolName: string, input: Record<string, unknown>) => void;
}

async function drainAgent(
  events: AsyncGenerator<import("../../types/index.js").AgentEvent>,
  onActivity: (line: string) => void,
  onToolActivity: ActivityCallbackRef,
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
  // Wrap the raw onToolActivity into rich "⎿ Reading src/foo.ts" lines and
  // publish it through the ref BEFORE the first generator pull (the native
  // session — and therefore the tool wrapper — is built lazily on first
  // next(), so the stable outer callback will see this wrapped one).
  if (onToolActivity) {
    onToolActivity.current = (toolName: string, input: Record<string, unknown>) => {
      const line = `⎿ ${describeToolActivity(toolName, input)}`;
      acc.activity.push(line);
      onActivity(`${line}\n`);
    };
  }
  for await (const ev of events) {
    if (ev.type === "text-delta") {
      acc.reply += ev.text;
    } else if (ev.type === "tool-call-start") {
      acc.toolUses++;
      if (!onToolActivity.current) {
        // Fallback: tool name only (the engine event carries no input).
        const line = `⎿ ${ev.toolName}`;
        acc.activity.push(line);
        onActivity(`${line}\n`);
      }
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
  requiredPermission: "allowRead",
  description: DESCRIPTION,
  inputSchema,

  async call(
    args: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const subagentType = args.subagent_type;
    const resolvedConfig = resolveSubagent(subagentType);
    if (!resolvedConfig) {
      return {
        data: `✗ Unknown sub-agent type "${subagentType}". Available: ${agentManager.listAgentNames().join(", ")}`,
      };
    }
    const agentName = resolvedConfig.name;
    const desc = args.description ?? args.prompt.slice(0, 60);

    const agent = agentManager.createAgent(agentName, context.providerConfig);
    // Stable delegating callback: drainAgent publishes its rich-activity
    // wrapper through the ref before the generator's first pull (the native
    // session — and its tool wrapper — is built lazily on first next()).
    const activityRef: ActivityCallbackRef = {};
    const events = agent.run(
      args.prompt,
      [],
      context.workingDir,
      context.requestPermission,
      (toolName, input) => activityRef.current?.(toolName, input),
      // Foreground runs belong to the turn: ESC must stop the sub-agent too,
      // not just abandon the call while it keeps streaming and spending
      // tokens. Background runs deliberately get nothing, so they outlive the
      // interrupt and are stopped with TaskStop — Claude Code's split.
      args.run_in_background ? undefined : context.abortController?.signal,
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
        const acc = await drainAgent(events, (line) => appendTaskOutput(task.id, line), activityRef);
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
            // The turn that launched this subagent is the one that wants its
            // answer. The notification carries the reply itself, so the model
            // can act on a finished background agent without a second round
            // trip just to find out what it said.
            {
              result: acc.reply || undefined,
              usage: {
                totalTokens: acc.tokens,
                toolUses: acc.toolUses,
                durationMs: acc.durationMs,
              },
            },
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
    }, activityRef);
    // The turn was interrupted: the run above stops, but it stops *early*, so
    // reporting "done" would leave a truncated sub-agent reading as a finished
    // one in the task pill.
    const interrupted = !killed && (context.abortController?.signal.aborted ?? false);

    updateTaskState(
      task.id,
      killed || interrupted
        ? { status: "error", endedAt: Date.now(), error: "Terminated by user." }
        : acc.error
          ? { status: "error", endedAt: Date.now(), error: acc.error }
          : { status: "done", endedAt: Date.now(), exitCode: 0 },
    );
    appendTaskOutput(
      task.id,
      `\n${killed || interrupted ? "✗ Terminated by user." : acc.error ? `✗ ${acc.error}` : `Done (${acc.toolUses} tool uses · ${acc.tokens.toLocaleString()} tokens · ${formatDuration(acc.durationMs)})`}\n`,
    );

    // Usually moot — the wrapper abandons this call when the turn aborts — but
    // if this result does reach the model it must not read as a finished run.
    if (interrupted) {
      return { data: `✗ Sub-agent (${subagentType}) interrupted with the turn.` };
    }

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

  /**
   * A sub-agent may never hold a capability its parent does not.
   *
   * This tool had no permission check at all, so every spawn was auto-approved
   * — and the plan/review agents, which are read-only precisely so a
   * "look but don't touch" mode is trustworthy, could call
   * `Agent(subagent_type: "code")` and get a full write+execute agent running
   * with their requestPermission. Plan mode's whole guarantee leaked through
   * one tool call. Capability, unlike the safety floor, is a floor on the
   * *input*, which is why it lives here rather than in a `requiredPermission`
   * on the tool.
   */
  checkCapability: (
    input: z.infer<typeof inputSchema>,
    context: ToolUseContext,
  ): PermissionDecision | null => {
    const config = resolveSubagent(input.subagent_type);
    // Unknown name: call() reports it with the list of valid ones.
    if (!config) return null;

    // Plan mode is a property of the turn, not of the spawning agent: `code`
    // in plan mode (Shift+Tab) is read-only too, and it must not reach write
    // access by delegating. Read-only sub-agents stay available — that is what
    // plan mode is for.
    if (
      context.getPlanMode() &&
      (config.permissions.allowWrite || config.permissions.allowExecute)
    ) {
      return {
        approved: false,
        feedback:
          `plan mode is read-only, and sub-agent "${config.name}" can write or ` +
          `execute. Spawn a read-only sub-agent (explore, plan), or leave plan ` +
          `mode (Shift+Tab) to delegate work that changes things.`,
      };
    }

    const missing = (
      ["allowRead", "allowWrite", "allowExecute", "allowNetwork"] as const
    ).find((flag) => config.permissions[flag] && !context.permissions[flag]);
    if (!missing) return null;
    return {
      approved: false,
      feedback:
        `sub-agent "${config.name}" needs the ${missing} capability and this agent ` +
        `does not have it — a sub-agent cannot be given more access than the agent ` +
        `that spawns it. Use a read-only sub-agent (explore, plan), or switch to an ` +
        `agent with ${missing}.`,
    };
  },

  isReadOnly: (input: z.infer<typeof inputSchema>) => {
    const config = resolveSubagent(input.subagent_type);
    if (config) return !config.permissions.allowWrite && !config.permissions.allowExecute;
    return input.subagent_type === "plan";
  },

  isConcurrencySafe: () => true,

  userFacingName: (input: z.infer<typeof inputSchema>) =>
    `Sub-agent (${input.subagent_type}): ${input.description ?? input.prompt.slice(0, 60)}`,
}) satisfies import("../../Tool.js").Tool;
