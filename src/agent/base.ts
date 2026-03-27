  // Agent system — agentic loop with tool calling via AI SDK
//
// Implements a manual multi-step loop:
//   1. Call streamText with tools
//   2. Stream text-delta and tool events to TUI
//   3. After stream ends, check if model made tool calls
//   4. If yes, add tool call/result messages and loop
//   5. Continue until no tool calls or maxSteps reached
//
// Uses `as any` casts for AI SDK options to work around
// Zod v4 ↔ AI SDK v6 type inference issues.

import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type { AgentConfig, AgentEvent, Message, ProviderConfig } from "../core/types.js";
import { createModel } from "../provider/registry.js";
import { createTools, type PermissionCallback } from "../tool/index.js";

// ─── Error categorization ──────────────────────────────────────────────────

type ErrorCategory = "auth" | "rate-limit" | "network" | "server" | "timeout" | "unknown";

function categorizeError(error: unknown): { category: ErrorCategory; message: string; retryable: boolean } {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  // DeepSeek API error codes
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
    return { category: "rate-limit", message: `Rate limited — retrying automatically`, retryable: true };
  }
  if (lower.includes("500") || lower.includes("server error")) {
    return { category: "server", message: `Server error — retrying automatically`, retryable: true };
  }
  if (lower.includes("503") || lower.includes("overloaded")) {
    return { category: "server", message: `Server overloaded — retrying automatically`, retryable: true };
  }
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("etimedout") || lower.includes("network") || lower.includes("fetch failed")) {
    return { category: "network", message: `Network error — retrying automatically`, retryable: true };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { category: "timeout", message: `Timeout: ${msg}`, retryable: false };
  }

  return { category: "unknown", message: msg, retryable: false };
}

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

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

export class Agent {
  private model: LanguageModel;
  private config: AgentConfig;
  private abortController: AbortController | null = null;

  constructor(
    config: AgentConfig,
    providerConfig: ProviderConfig,
  ) {
    this.config = config;
    this.model = createModel(providerConfig);
  }

  get name() { return this.config.name; }
  get displayName() { return this.config.displayName; }
  get description() { return this.config.description; }
  get permissions() { return this.config.permissions; }

  /** Abort the current generation */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Run the agent with a user message and history.
   * Returns an async generator that yields AgentEvents for the TUI.
   */
  async *run(
    userMessage: string,
    history: Message[],
    workingDir: string,
    requestPermission?: PermissionCallback,
  ): AsyncGenerator<AgentEvent> {
    const runAbortController = new AbortController();
    this.abortController = runAbortController;

    // Create tools based on agent permissions
    const { tools, getLastPermissionWaitMs } = createTools(workingDir, this.config.permissions, requestPermission);
    const hasTools = Object.keys(tools).length > 0;

    // Build initial messages from history
    const apiMessages: any[] = history
      .filter((m) => m.role !== "system")
      .slice(-30)
      .map((m) => ({ role: m.role, content: m.content }));
    apiMessages.push({ role: "user", content: userMessage });

    const maxSteps = this.config.maxSteps || 25;
    let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      for (let step = 0; step < maxSteps; step++) {
        if (runAbortController.signal.aborted) break;

        // Track tool calls and results for this step
        const stepToolCalls: ToolCallInfo[] = [];
        const stepToolResults: ToolResultInfo[] = [];
        const toolStartTimes = new Map<string, number>();
        let stepText = "";

        // Call streamText for one step
        const streamOptions: any = {
          model: this.model,
          system: this.config.systemPrompt,
          messages: apiMessages,
          tools: hasTools ? tools : undefined,
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          abortSignal: runAbortController.signal,
        };

        let result;
        let retries = 0;

        while (true) {
          try {
            result = await streamText(streamOptions);
            break; // Success — exit retry loop
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
              runAbortController.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve();
              }, { once: true });
            });

            if (runAbortController.signal.aborted) return;
          }
        }

        // Stream events from this step
        for await (const event of result.fullStream) {
          if (runAbortController.signal.aborted) break;

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
                args: typeof input === "object" ? input as Record<string, unknown> : { value: input },
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
              const permissionWait = getLastPermissionWaitMs?.() ?? 0;
              const duration = Math.max(0, Date.now() - startTime - permissionWait);

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
                totalUsage.promptTokens += f.usage.promptTokens || 0;
                totalUsage.completionTokens += f.usage.completionTokens || 0;
                totalUsage.totalTokens += f.usage.totalTokens || 0;
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
        // to the message history for the next loop iteration
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
        // AI SDK v6: ToolResultPart = { type: "tool-result", toolCallId, toolName, output: ToolResultOutput }
        // ToolResultOutput = { type: "text", value: string } | { type: "json", value: JSONValue }
        const toolResultParts = stepToolResults.map((tr) => ({
          type: "tool-result",
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          output: {
            type: "text",
            value: typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output),
          },
        }));
        apiMessages.push({ role: "tool", content: toolResultParts });

        // Reset stepText for next iteration (text after tool results)
        stepText = "";
      }

      // Emit finish
      yield {
        type: "finish",
        usage: totalUsage,
        finishReason: "stop",
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        yield { type: "error", error: "Generation interrupted." };
      } else {
        const categorized = categorizeError(error);
        yield { type: "error", error: categorized.message };
      }
    } finally {
      if (this.abortController === runAbortController) {
        this.abortController = null;
      }
    }
  }
}
