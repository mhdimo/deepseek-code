// Streaming query engine — AsyncGenerator-based agentic loop
//
// Implements the core query loop that:
//   1. Builds messages for the API (with context management)
//   2. Calls streamText with tools
//   3. Streams text-delta, thinking-delta, and tool events to the TUI
//   4. After stream ends, checks for tool calls
//   5. If tool calls: adds tool results, checks token budget, auto-compacts, loops
//   6. Continues until no tool calls or maxSteps reached
//
// Uses `as any` casts for AI SDK options to work around
// Zod v4 ↔ AI SDK v6 type inference issues.

import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type {
  AgentConfig,
  Message,
  QueryEvent,
  TokenUsage,
} from "../types/index.js";
import { getTools, toolsToAISDKFormat } from "../tools.js";
import type { PermissionCallback } from "../Tool.js";
import { TokenTracker } from "./tokenTracker.js";
import { ContextManager } from "./contextManager.js";

// ─── Error categorization ───────────────────────────────────────────────────

type ErrorCategory = "auth" | "rate-limit" | "network" | "server" | "timeout" | "unknown";

function categorizeError(error: unknown): {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
} {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes("401") || lower.includes("invalid api key") || lower.includes("authentication")) {
    return { category: "auth", message: `Authentication error: ${msg}`, retryable: false };
  }
  if (lower.includes("402") || lower.includes("insufficient balance")) {
    return { category: "auth", message: `Insufficient balance: ${msg}`, retryable: false };
  }
  if (lower.includes("422") || lower.includes("invalid parameters")) {
    return { category: "auth", message: `Invalid parameters: ${msg}`, retryable: false };
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { category: "rate-limit", message: `Rate limited`, retryable: true };
  }
  if (lower.includes("500") || lower.includes("server error")) {
    return { category: "server", message: `Server error`, retryable: true };
  }
  if (lower.includes("503") || lower.includes("overloaded")) {
    return { category: "server", message: `Server overloaded`, retryable: true };
  }
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("etimedout") || lower.includes("network") || lower.includes("fetch failed")) {
    return { category: "network", message: `Network error`, retryable: true };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { category: "timeout", message: `Timeout: ${msg}`, retryable: false };
  }

  return { category: "unknown", message: msg, retryable: false };
}

// ─── Internal types ─────────────────────────────────────────────────────────

interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

interface ToolResultInfo {
  toolCallId: string;
  toolName: string;
  output: unknown;
}

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// ─── Query parameters ───────────────────────────────────────────────────────

export interface QueryParams {
  model: LanguageModel;
  config: AgentConfig;
  userMessage: string;
  history: Message[];
  workingDir: string;
  abortController: AbortController;
  requestPermission?: PermissionCallback;
  tokenTracker?: TokenTracker;
  contextManager?: ContextManager;
}

// ─── Main query generator ───────────────────────────────────────────────────

/**
 * Execute a streaming query with tool calling.
 *
 * This is the core agentic loop — yields QueryEvents for the TUI to render.
 * Handles:
 *   - Multi-step tool calling loop
 *   - Retry on rate limits / server errors
 *   - Auto-compaction when context exceeds budget
 *   - Token usage tracking and cost estimation
 */
export async function* query(params: QueryParams): AsyncGenerator<QueryEvent> {
  const {
    model,
    config,
    userMessage,
    history,
    workingDir,
    abortController,
    requestPermission,
    tokenTracker = new TokenTracker("deepseek-chat"),
    contextManager = new ContextManager("deepseek-chat"),
  } = params;

  // Create tools based on agent permissions
  const allTools = getTools(config.permissions);
  const tools = toolsToAISDKFormat(allTools, {
    workingDir,
    permissions: config.permissions,
    abortController,
    requestPermission: requestPermission ?? (() => Promise.resolve({ approved: true })),
    messages: history,
    getTodos: () => [],
    setTodos: () => {},
    getTasks: () => [],
    setTasks: () => {},
    getPlanMode: () => false,
    setPlanMode: () => {},
    lastPermissionWaitMs: 0,
    recordPermissionWait: () => {},
    consumePermissionWaitMs: () => 0,
  });
  const hasTools = Object.keys(tools).length > 0;

  // Build initial messages from history
  let apiMessages: any[] = contextManager
    .prepareForAPI(history)
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  apiMessages.push({ role: "user", content: userMessage });

  const maxSteps = config.maxSteps || 25;
  let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (abortController.signal.aborted) break;

      // ── Auto-compaction check ────────────────────────────────────────────
      if (contextManager.needsCompaction(history)) {
        const compacted = contextManager.compact(history);
        if (compacted.before > compacted.after) {
          yield {
            type: "compact",
            reason: "Context approaching token limit",
            messagesBefore: compacted.before,
            messagesAfter: compacted.after,
          } as QueryEvent;

          // Rebuild API messages from compacted history
          apiMessages = contextManager
            .prepareForAPI(compacted.messages)
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role, content: m.content }));
        }
      }

      // Track tool calls and results for this step
      const stepToolCalls: ToolCallInfo[] = [];
      const stepToolResults: ToolResultInfo[] = [];
      const toolStartTimes = new Map<string, number>();
      let stepText = "";

      // Call streamText for one step
      const streamOptions: any = {
        model,
        system: config.systemPrompt,
        messages: apiMessages,
        tools: hasTools ? tools : undefined,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        abortSignal: abortController.signal,
      };

      let result;
      let retries = 0;

      // Retry loop for transient errors
      while (true) {
        try {
          result = await streamText(streamOptions);
          break;
        } catch (streamError) {
          const categorized = categorizeError(streamError);

          if (!categorized.retryable || retries >= MAX_RETRIES) {
            yield { type: "error", error: categorized.message };
            return;
          }

          retries++;
          const delayMs = RETRY_BASE_MS * Math.pow(2, retries - 1);

          yield {
            type: "text-delta",
            text: `\n⏳ ${categorized.message} — retrying in ${delayMs / 1000}s (${retries}/${MAX_RETRIES})…\n`,
          };

          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs);
            abortController.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });

          if (abortController.signal.aborted) return;
        }
      }

      // Stream events from this step
      for await (const event of result.fullStream) {
        if (abortController.signal.aborted) break;

        const eventType = (event as any).type as string;

        switch (eventType) {
          case "reasoning": {
            const text = (event as any).textDelta ?? "";
            if (text) {
              yield { type: "thinking-delta", text };
            }
            break;
          }

          case "text-delta": {
            const text = (event as any).textDelta ?? (event as any).text ?? "";
            stepText += text;
            yield { type: "text-delta", text };
            break;
          }

          case "tool-call": {
            const tc = event as any;
            const toolCallId = tc.toolCallId || `tc-${step}-${stepToolCalls.length}`;
            const toolName = tc.toolName || "";
            const input = tc.args ?? tc.input ?? {};

            toolStartTimes.set(toolCallId, Date.now());
            stepToolCalls.push({ toolCallId, toolName, input });

            yield {
              type: "tool-call-start",
              toolCallId,
              toolName,
              args: typeof input === "object"
                ? (input as Record<string, unknown>)
                : { value: input },
            };
            break;
          }

          case "tool-result": {
            const tr = event as any;
            const toolCallId = tr.toolCallId || "";
            const toolName = tr.toolName || "";
            const output = tr.result ?? tr.output ?? "";
            const resultStr = typeof output === "string" ? output : JSON.stringify(output);
            const startTime = toolStartTimes.get(toolCallId) || Date.now();
            const duration = Math.max(0, Date.now() - startTime);

            stepToolResults.push({ toolCallId, toolName, output });

            yield {
              type: "tool-call-result",
              toolCallId,
              toolName,
              result: resultStr,
              duration,
            };
            break;
          }

          case "finish": {
            const f = event as any;
            if (f.usage) {
              const stepUsage: TokenUsage = {
                promptTokens: f.usage.promptTokens || 0,
                completionTokens: f.usage.completionTokens || 0,
                totalTokens: f.usage.totalTokens || 0,
              };

              totalUsage.promptTokens += stepUsage.promptTokens;
              totalUsage.completionTokens += stepUsage.completionTokens;
              totalUsage.totalTokens += stepUsage.totalTokens;

              // Track in token tracker
              tokenTracker.addStepUsage(stepUsage);

              // Emit token usage event
              const cost = tokenTracker.estimateCost(totalUsage);
              yield { type: "token-usage", usage: totalUsage, cost };
            }
            break;
          }

          case "error": {
            const errMsg = (event as any).error instanceof Error
              ? ((event as any).error as Error).message
              : String((event as any).error);
            yield { type: "error", error: errMsg };
            return;
          }
        }
      }

      // If no tool calls were made, we're done
      if (stepToolCalls.length === 0) break;

      // Otherwise, append assistant message (text + tool calls) and tool results
      // AI SDK v6 schema: ToolCallPart uses `input` (not `args`)
      const assistantParts: any[] = [];
      if (stepText) {
        assistantParts.push({ type: "text", text: stepText });
      }
      for (const tc of stepToolCalls) {
        assistantParts.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        });
      }
      apiMessages.push({ role: "assistant", content: assistantParts });

      // Add tool results as a single "tool" message
      // AI SDK v6: ToolResultPart = { type: "tool-result", toolCallId, toolName, output }
      const toolResultParts = stepToolResults.map((tr) => ({
        type: "tool-result" as const,
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        output: {
          type: "text" as const,
          value: typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output),
        },
      }));
      apiMessages.push({ role: "tool", content: toolResultParts });

      // Reset stepText for next iteration
      stepText = "";
    }

    // Emit finish with cost
    const finalCost = tokenTracker.estimateCost(totalUsage);
    yield {
      type: "finish",
      usage: totalUsage,
      cost: finalCost,
      finishReason: "stop",
    };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      yield { type: "error", error: "Generation interrupted." };
    } else {
      const categorized = categorizeError(error);
      yield { type: "error", error: categorized.message };
    }
  }
}
