

























import { getOrCreateMemorySession } from "../services/agent/agentSession.js";
import { protectedWriteReason } from "../services/protectedPaths.js";
import { EMPTY_FINISH_REASON, emptyTurnMessage, isEmptyTurn } from "../services/recovery.js";
import { LIMIT_FINISH_REASON, reachedStepLimit, stepLimitError } from "../services/stepLimit.js";
import {
  formatTaskNotifications,
  pendingTaskNotificationCount,
  takeTaskNotifications,
} from "../services/tasks/notifications.js";
import type { PermissionCallback } from "../Tool.js";
import { agentManager } from "../services/agent/index.js";
import type { StreamEvent } from "ai-sdk-cpp";
import { homedir } from "node:os";
import type { AgentConfig, ProviderConfig, Message, MCPServerConfig } from "../types/index.js";
import { existsSync, readFileSync } from "node:fs";



export interface PrintOptions {
  
  prompt: string;
  
  model?: string;
  
  systemOverride?: string;
  
  systemPromptFile?: string;
  
  outputFormat?: "text" | "json";
  
  maxTurns?: number;
  
  workingDir?: string;
  
  memoryDir?: string;
  
  maxContextTokens?: number;
  
  providerConfig: ProviderConfig;
  
  agent?: "code" | "plan" | "review";
  
  history?: Message[];
  
  mcpServers?: Record<string, MCPServerConfig>;
  
  verbose?: boolean;
  
  streamText?: boolean;

  /** `--dangerously-skip-permissions`: also let headless approval through for
   *  protected paths (.git, ~/.zshrc, .claude/settings.json). Off by default,
   *  so an unattended run cannot rewrite them just by not being watched. */
  dangerouslySkipPermissions?: boolean;
}



export interface PrintResult {
  text: string;
  
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    result: string;
    isError: boolean;
    durationMs: number;
  }>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: string;

  durationMs: number;

  /**
   * Every call the permission layer refused, in the order it refused them.
   *
   * Nothing here was approved: the entry means the tool did NOT run. A headless
   * run reports success by exit code and stdout, so without this a job that was
   * quietly denied its writes looks exactly like one that made them — the model
   * is told (it gets the refusal as the tool result) and the operator is not.
   */
  permissionDenials: Array<{ tool: string; reason: string }>;
}




/**
 * The permission callback for a run with nobody to ask.
 *
 * Everything is approved — that is what `--print` means — except a write the
 * protected-path guard would have prompted for. A protected file must not
 * change *because* no one was there to say no, so those are refused instead,
 * with the reason handed back to the model as the tool result. The escape
 * hatch is the explicit one (`--dangerously-skip-permissions`): the same grant
 * of authority, and gated the same way in index.tsx (`assertBypassSafe`).
 */
export function createHeadlessApprover(workingDir: string, allowProtected = false): PermissionCallback {
  return async (toolName, _description, input) => {
    if (allowProtected) return { approved: true };
    const reason = protectedWriteReason(
      toolName,
      input as Record<string, unknown> | undefined,
      workingDir,
    );
    if (reason) {
      return {
        approved: false,
        feedback:
          `${reason}, and --print has no one to ask. ` +
          `Make the change yourself, or pass --dangerously-skip-permissions if you mean it.`,
      };
    }
    return { approved: true };
  };
}

export async function runPrint(opts: PrintOptions): Promise<PrintResult> {
  const {
    prompt,
    model,
    outputFormat = "text",
    maxTurns,
    workingDir = process.cwd(),
    memoryDir,
    maxContextTokens,
    providerConfig,
    agent = "code",
    history,
    mcpServers,
    verbose = false,
    streamText = outputFormat === "text",
    dangerouslySkipPermissions: skipProtectedWrites = false,
  } = opts;

  
  const agentConfig = cloneAgentConfig(agentManager.getConfig(agent), {
    maxSteps: maxTurns,
    systemPrompt: resolveSystemPrompt(opts),
  });

  const providerCfg: ProviderConfig = model
    ? { ...providerConfig, model }
    : providerConfig;

  

  const autoApprove = createHeadlessApprover(workingDir, skipProtectedWrites);

  const { session } = await getOrCreateMemorySession({
    // Headless has nothing to repaint, so the value here is different: the
    // connect is synchronous and has no timeout, so a server that never
    // answers stops the process *before it prints anything at all*. One line
    // on stderr is the difference between a CI job that is stuck and one that
    // says what it is stuck on.
    onMcpConnect: (name) => {
      process.stderr.write(`[mcp] connecting to "${name}"…\n`);
    },
    providerConfig: providerCfg,
    agentConfig,
    workingDir,
    memoryDir: memoryDir ?? `${homedirSafe()}/.deepseek-code/memory`,
    maxContextTokens,
    requestPermission: autoApprove,
    mcpServers,
    history,
    abortController: new AbortController(),
    // Refusals the model was told about and the operator was not. Collected
    // here and reported in the envelope below; stderr too, because a JSON
    // consumer that only checks the exit code should still see it in a log.
    onPermissionDenied: (toolName, reason) => {
      permissionDenials.push({ tool: toolName, reason });
      process.stderr.write(`\n[denied] ${toolName}: ${reason}\n`);
    },
    onToolResult: (toolName, input, output, isError) => {
      if (verbose) {
        
        
        const preview = truncate(output, 200);
        process.stderr.write(
          `\r[K[tool] ${toolName}${isError ? " (error)" : ""}: ${preview}\n`,
        );
      }
    },
  });

  const startedAt = Date.now();
  const textParts: string[] = [];
  const toolCalls: PrintResult["toolCalls"] = [];
  const permissionDenials: PrintResult["permissionDenials"] = [];
  
  const inflight = new Map<string, { name: string; input: Record<string, unknown>; startedAt: number }>();

  let usage: PrintResult["usage"] = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  let finishReason = "stop";
  let streamError: string | null = null;
  let steps = 0;
  // A turn that produced nothing is indistinguishable from a completed one on
  // the wire, so count the model's own output — see services/recovery.ts.
  let outputEvents = 0;

  // A background task that finishes while the run is going is news the model
  // has never seen — the tool descriptions promise it will be told, and the
  // TUI tells it before the next prompt (App.tsx: takeTaskNotifications). With
  // no drain here, `--print` discarded the queue at exit and a CI job whose
  // background command failed reported success.
  //
  // Each drained round is another send, so it is bounded: a run cannot be
  // extended indefinitely by tasks that keep finishing.
  const MAX_NOTIFICATION_TURNS = 4;
  let nextPrompt = prompt;
  let notificationTurns = 0;

  try {
    for (;;) {
      for await (const ev of session.sendStream(nextPrompt) as AsyncGenerator<StreamEvent>) {
        switch (ev.type) {
        case "text_delta": {
          const chunk = ev.text || "";
          if (chunk) outputEvents += 1;
          textParts.push(chunk);
          if (streamText) {
            process.stdout.write(chunk);
          }
          break;
        }
        case "tool_call_start": {
          outputEvents += 1;
          const id = ev.toolCallId || syntheticId();
          inflight.set(id, {
            name: ev.toolName || "(unknown)",
            input: {},
            startedAt: Date.now(),
          });
          if (verbose) {
            process.stderr.write(`\r[K[tool] start ${ev.toolName || "?"}\n`);
          }
          break;
        }
        case "tool_call_delta": {
          
          
          
          break;
        }
        case "tool_call_end": {
          
          break;
        }
        case "tool_result": {
          const id = ev.toolCallId || "";
          const entry = inflight.get(id);
          if (entry) {
            toolCalls.push({
              name: entry.name,
              input: entry.input,
              result: ev.text || "",
              isError: false,
              durationMs: Date.now() - entry.startedAt,
            });
            inflight.delete(id);
          } else {
            
            toolCalls.push({
              name: ev.toolName || "(unknown)",
              input: {},
              result: ev.text || "",
              isError: false,
              durationMs: 0,
            });
          }
          break;
        }
        case "step_finish": {
          steps += 1;
          break;
        }
        case "finish": {
          if (ev.usage) {
            usage = {
              promptTokens: ev.usage.inputTokens,
              completionTokens: ev.usage.outputTokens,
              totalTokens: ev.usage.inputTokens + ev.usage.outputTokens,
            };
          }
          break;
        }
        case "error": {
          streamError = ev.text || "stream error";
          break;
        }


          default:
            break;
        }}

      // The turn is over. Deliver whatever finished during it — the same queue
      // and the same formatter the TUI uses, so headless and interactive runs
      // tell the model the same thing. Sending is the only way to say
      // anything: the engine owns history (services/tasks/notifications.ts).
      const news = formatTaskNotifications(takeTaskNotifications());
      if (!news || streamError || reachedStepLimit(steps, agentConfig.maxSteps)) break;
      if (notificationTurns >= MAX_NOTIFICATION_TURNS) {
        // Say what was dropped rather than discarding it in silence.
        process.stderr.write(
          `\n[task] ${pendingTaskNotificationCount()} background-task notification(s) ` +
            `were not delivered: the run already used its ${MAX_NOTIFICATION_TURNS} ` +
            `follow-up turns.\n`,
        );
        break;
      }
      notificationTurns += 1;
      // The run's output is now more than one turn's worth. Without a break the
      // two answers run together — "…nothing else to report.Started the…" —
      // which reads as a stutter rather than as two replies.
      if (textParts.length > 0) {
        textParts.push("\n\n");
        if (streamText) process.stdout.write("\n\n");
      }
      if (verbose) {
        process.stderr.write(`\r[K[task] reporting a finished background task to the model\n`);
      }
      nextPrompt = news;
    }
  } catch (err) {
    streamError = (err as Error).message || String(err);
  }

  
  for (const [, entry] of inflight) {
    toolCalls.push({
      name: entry.name,
      input: entry.input,
      result: "",
      isError: true,
      durationMs: Date.now() - entry.startedAt,
    });
  }

  const text = textParts.join("").trimEnd();
  const durationMs = Date.now() - startedAt;

  if (streamError) {
    
    
    if (outputFormat === "json") {
      const result: PrintResult = {
        text,
        toolCalls,
        usage,
        finishReason: "error",
        durationMs,
        permissionDenials,
      };
      process.stdout.write(JSON.stringify({ ...result, error: streamError }) + "\n");
      throw new Error(streamError);
    }
    process.stderr.write(`\nError: ${streamError}\n`);
    throw new Error(streamError);
  }

  // A run that spent its whole step budget may have stopped mid-task, and
  // "printed something, exited 0" is how CI learns a truncated refactor went
  // fine. Say so on stderr (text mode) and in finishReason (json mode); the
  // caller turns that into a non-zero exit.
  const hitStepLimit = reachedStepLimit(steps, agentConfig.maxSteps);
  // Same argument for a run that produced nothing: a rejected request ends the
  // stream exactly like a finished one, and printing nothing while exiting 0
  // would let CI read a dead API key as a successful no-op.
  const emptyTurn = !hitStepLimit && isEmptyTurn(usage.totalTokens, outputEvents);
  if (hitStepLimit) finishReason = LIMIT_FINISH_REASON;
  else if (emptyTurn) finishReason = EMPTY_FINISH_REASON;

  const result: PrintResult = {
    text,
    toolCalls,
    usage,
    finishReason,
    durationMs,
    permissionDenials,
  };

  if (hitStepLimit) {
    process.stderr.write(`\n${stepLimitError(agentConfig.maxSteps!)}\n`);
  } else if (emptyTurn) {
    process.stderr.write(`\nError: ${emptyTurnMessage(providerCfg.model)}\n`);
  }

  if (outputFormat === "json") {
    
    
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (!streamText) {
    
    if (text) process.stdout.write(text + "\n");
  } else {
    
    process.stdout.write("\n");
  }

  return result;
}




function cloneAgentConfig(
  base: AgentConfig,
  overrides: { maxSteps?: number; systemPrompt?: string },
): AgentConfig {
  return {
    ...base,
    permissions: { ...base.permissions },
    maxSteps: overrides.maxSteps ?? base.maxSteps,
    systemPrompt: overrides.systemPrompt ?? base.systemPrompt,
  };
}


function resolveSystemPrompt(opts: PrintOptions): string | undefined {
  if (opts.systemOverride !== undefined) return opts.systemOverride;
  if (opts.systemPromptFile) {
    if (!existsSync(opts.systemPromptFile)) {
      throw new Error(`System prompt file not found: ${opts.systemPromptFile}`);
    }
    return readFileSync(opts.systemPromptFile, "utf-8");
  }
  return undefined; 
}

let _idCounter = 0;
function syntheticId(): string {
  _idCounter += 1;
  return `synthetic-${_idCounter}`;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}


function homedirSafe(): string {
  try {
    return homedir();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || "/tmp";
  }
}
