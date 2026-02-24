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
    this.abortController = null;
  }

  /**
   * Run the agent with a user message and history.
   * Returns an async generator that yields AgentEvents for the TUI.
   *
   * @param thinkingBudget  If > 0, enable extended thinking with this token budget.
   *                        Only effective for Anthropic models.
   */
  async *run(
    userMessage: string,
    history: Message[],
    workingDir: string,
    requestPermission?: PermissionCallback,
    thinkingBudget?: number,
  ): AsyncGenerator<AgentEvent> {
    this.abortController = new AbortController();

    // Create tools based on agent permissions
    const tools = createTools(workingDir, this.config.permissions, requestPermission);
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
        if (this.abortController.signal.aborted) break;

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
          abortSignal: this.abortController.signal,
        };

        // Enable extended thinking for Anthropic if budget is set
        if (thinkingBudget && thinkingBudget > 0) {
          streamOptions.providerOptions = {
            anthropic: {
              thinking: { type: "enabled", budgetTokens: thinkingBudget },
            },
          };
        }

        const result = await streamText(streamOptions);

        // Stream events from this step
        for await (const event of result.fullStream) {
          if (this.abortController.signal.aborted) break;

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
              const duration = Date.now() - startTime;

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
        yield { type: "error", error: (error as Error).message };
      }
    } finally {
      this.abortController = null;
    }
  }
}
