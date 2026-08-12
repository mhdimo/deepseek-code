// Headless / non-interactive mode for DeepSeek Code.
//
// runPrint() runs ONE prompt against the existing ai-sdk-cpp Agent/Session
// (the same engine the TUI uses) and prints the result to stdout WITHOUT
// rendering Ink. It reuses getOrCreateMemorySession() from
// services/agent/agentSession.ts — so the C++ backend still owns history,
// auto-compaction, memory injection, MCP toolsets, and providers. We only
// swap the IO: permissions are auto-approved (headless), tool output is
// suppressed unless --verbose, and the final assistant text (or a JSON
// envelope) goes to stdout.
//
// This is the automation/CI entrypoint:
//   deepseek-code -p "fix the failing tests" --output-format json --max-turns 20
//
// Design notes:
//  - We do NOT reimplement streaming/loop/compaction in TS. The C++ Session
//    owns all of that. We simply drive session.sendStream(prompt) and map the
//    native StreamEvents into accumulated output.
//  - We bypass the TS query() wrapper (services/query.ts) because that wrapper
//    exists to feed Ink's QueryEvent reducer; headless mode needs raw text +
//    a structured result, not UI deltas. Driving sendStream directly keeps
//    headless mode decoupled from the TUI's event shape.
//  - Permissions: a no-op PermissionCallback that always approves, matching
//    the TUI's --dangerously-skip-permissions path. Callers should gate this
//    upstream (index.tsx already refuses bypass-as-root-outside-sandbox).

import { getOrCreateMemorySession } from "../services/agent/agentSession.js";
import { agentManager } from "../services/agent/index.js";
import type { StreamEvent } from "ai-sdk-cpp";
import { homedir } from "node:os";
import type { AgentConfig, ProviderConfig, Message, MCPServerConfig } from "../types/index.js";
import { existsSync, readFileSync } from "node:fs";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface PrintOptions {
  /** The user's prompt. Required. */
  prompt: string;
  /** Model id (e.g. "deepseek-chat"). Defaults to providerConfig.model. */
  model?: string;
  /** Optional full system-prompt override. Replaces the agent's identity. */
  systemOverride?: string;
  /** Path to a file whose contents replace the system prompt. */
  systemPromptFile?: string;
  /** "text" (default) prints final assistant text; "json" prints a structured
   *  envelope with text, tool calls, usage, and finish reason. */
  outputFormat?: "text" | "json";
  /** Cap on agent turns (tool-call steps). Falls back to agent.maxSteps. */
  maxTurns?: number;
  /** Working directory for file tools. Defaults to process.cwd(). */
  workingDir?: string;
  /** Memory directory for the C++ MemoryContextStrategy. */
  memoryDir?: string;
  /** Max context tokens before the C++ side auto-compacts. */
  maxContextTokens?: number;
  /** Provider config (api key, base url, model). Required. */
  providerConfig: ProviderConfig;
  /** Agent name to drive permissions/tools. Default "code". */
  agent?: "code" | "plan" | "review";
  /** Optional seed history (e.g. from a resumed session). */
  history?: Message[];
  /** Optional MCP servers (same shape as config.mcpServers). */
  mcpServers?: Record<string, MCPServerConfig>;
  /** When true, stream tool-call names + results to stderr as they happen. */
  verbose?: boolean;
  /** Stream text deltas to stdout as they arrive (text mode only). */
  streamText?: boolean;
}

// ─── Result (json output-format envelope) ─────────────────────────────────────

export interface PrintResult {
  text: string;
  /** Tool calls in execution order: { name, input, result, isError }. */
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
  /** Elapsed wall-clock ms for the whole run. */
  durationMs: number;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Run one prompt headlessly and write the result to stdout. Resolves with the
 * structured result (so programmatic callers can use it too). Throws on fatal
 * stream errors; the caller is responsible for process.exit codes.
 */
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
  } = opts;

  // Resolve the system prompt: explicit override > file > agent default.
  const agentConfig = cloneAgentConfig(agentManager.getConfig(agent), {
    maxSteps: maxTurns,
    systemPrompt: resolveSystemPrompt(opts),
  });

  const providerCfg: ProviderConfig = model
    ? { ...providerConfig, model }
    : providerConfig;

  // Headless = auto-approve every permission. The TUI gates
  // --dangerously-skip-permissions; headless always implies it.
  const autoApprove = async () => ({ approved: true });

  const { session } = getOrCreateMemorySession({
    providerConfig: providerCfg,
    agentConfig,
    workingDir,
    memoryDir: memoryDir ?? `${homedirSafe()}/.deepseek-code/memory`,
    maxContextTokens,
    requestPermission: autoApprove,
    mcpServers,
    history,
    abortController: new AbortController(),
    onToolResult: (toolName, input, output, isError) => {
      if (verbose) {
        // Tool progress goes to stderr so it never pollutes stdout (the
        // machine-readable answer channel).
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
  // Track in-flight tool calls so we can attach their result + duration.
  const inflight = new Map<string, { name: string; input: Record<string, unknown>; startedAt: number }>();

  let usage: PrintResult["usage"] = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  let finishReason = "stop";
  let streamError: string | null = null;

  try {
    for await (const ev of session.sendStream(prompt) as AsyncGenerator<StreamEvent>) {
      switch (ev.type) {
        case "text_delta": {
          const chunk = ev.text || "";
          textParts.push(chunk);
          if (streamText) {
            process.stdout.write(chunk);
          }
          break;
        }
        case "tool_call_start": {
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
          // The binding streams raw argument JSON deltas; we don't parse them
          // (best-effort only) — the authoritative input is captured in the
          // onToolResult callback above for verbose/json consumers.
          break;
        }
        case "tool_call_end": {
          // No-op: result arrives via tool_result.
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
            // result without a start (older binding) — record it anyway.
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
        // reasoning_* and step_finish are intentionally ignored in headless
        // mode — they carry no machine-readable value for the caller.
        default:
          break;
      }
    }
  } catch (err) {
    streamError = (err as Error).message || String(err);
  }

  // Flush any tool calls that started but never produced a result.
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
    // In json mode, surface the error inside the envelope; in text mode, write
    // a human-readable line to stderr and exit non-zero via throw.
    if (outputFormat === "json") {
      const result: PrintResult = {
        text,
        toolCalls,
        usage,
        finishReason: "error",
        durationMs,
      };
      process.stdout.write(JSON.stringify({ ...result, error: streamError }) + "\n");
      throw new Error(streamError);
    }
    process.stderr.write(`\nError: ${streamError}\n`);
    throw new Error(streamError);
  }

  const result: PrintResult = {
    text,
    toolCalls,
    usage,
    finishReason,
    durationMs,
  };

  if (outputFormat === "json") {
    // Already streamed text in text mode; in json mode we emit the full
    // envelope as the only stdout content.
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (!streamText) {
    // Non-streaming text mode: emit the accumulated text in one shot.
    if (text) process.stdout.write(text + "\n");
  } else {
    // Streaming text mode already wrote deltas; ensure a trailing newline.
    process.stdout.write("\n");
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Deep-clone an AgentConfig and apply selective overrides. */
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

/** Resolve the final system prompt: explicit override > file > agent default. */
function resolveSystemPrompt(opts: PrintOptions): string | undefined {
  if (opts.systemOverride !== undefined) return opts.systemOverride;
  if (opts.systemPromptFile) {
    if (!existsSync(opts.systemPromptFile)) {
      throw new Error(`System prompt file not found: ${opts.systemPromptFile}`);
    }
    return readFileSync(opts.systemPromptFile, "utf-8");
  }
  return undefined; // fall back to the agent's built-in identity
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

/** homedir() that never throws (some sandboxed runtimes lack USERPROFILE). */
function homedirSafe(): string {
  try {
    return homedir();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || "/tmp";
  }
}
