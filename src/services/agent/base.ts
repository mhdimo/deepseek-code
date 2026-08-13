






import { streamText as bindingStreamText, type Model as BindingModel } from "ai-sdk-cpp";
import type { AgentConfig, AgentEvent, Message, ProviderConfig } from "../../types/index.js";
import { createModel } from "../provider/registry.js";
import { getTools, toolsToBindingFormat } from "../../tools.js";
import type { PermissionCallback, ToolUseContext } from "../../Tool.js";
import { buildSystemInstructions } from "../../utils/toolUtils.js";



type ErrorCategory = "auth" | "rate-limit" | "network" | "server" | "timeout" | "unknown";

function categorizeError(error: unknown): { category: ErrorCategory; message: string; retryable: boolean } {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes("401") || lower.includes("invalid api key") || lower.includes("authentication")) {
    return { category: "auth", message: `Authentication error: ${msg}`, retryable: false };
  }
  if (lower.includes("402") || lower.includes("insufficient balance")) {
    return { category: "auth", message: `Insufficient balance: ${msg}`, retryable: false };
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

export class Agent {
  private model: BindingModel;
  private config: AgentConfig;
  private providerConfig: ProviderConfig;
  private abortController: AbortController | null = null;

  constructor(config: AgentConfig, providerConfig: ProviderConfig) {
    this.config = config;
    this.providerConfig = providerConfig;
    this.model = createModel(providerConfig);
  }

  get name() { return this.config.name; }
  get displayName() { return this.config.displayName; }
  get description() { return this.config.description; }
  get permissions() { return this.config.permissions; }

  abort(): void {
    this.abortController?.abort();
  }

  
  async *run(
    userMessage: string,
    history: Message[],
    workingDir: string,
    requestPermission?: PermissionCallback,
  ): AsyncGenerator<AgentEvent> {
    const runAbortController = new AbortController();
    this.abortController = runAbortController;

    const context: ToolUseContext = {
      providerConfig: this.providerConfig,
      workingDir,
      permissions: this.config.permissions,
      abortController: runAbortController,
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
    };
    const tools = toolsToBindingFormat(getTools(this.config.permissions), context);

    const apiMessages: Array<{ role: string; content: string }> = history
      .filter((m) => m.role !== "system")
      .slice(-30)
      .map((m) => ({ role: m.role, content: m.content }));
    apiMessages.push({ role: "user", content: userMessage });

    
    const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      for await (const ev of bindingStreamText({
        model: this.model,
        system: buildSystemInstructions(this.config.systemPrompt, workingDir),
        messages: apiMessages,
        tools,
        maxSteps: this.config.maxSteps || 25,
        temperature: this.config.temperature,
        maxOutputTokens: this.config.maxTokens,
      })) {
        if (runAbortController.signal.aborted) break;
        switch (ev.type) {
          case "text_delta":
            yield { type: "text-delta", text: ev.text || "" };
            break;
          case "reasoning_delta":
            yield { type: "thinking-delta", text: ev.text || "" };
            break;
          case "tool_call_start":
            yield {
              type: "tool-call-start",
              toolCallId: ev.toolCallId || "",
              toolName: ev.toolName || "",
              args: {},
            };
            break;
          case "tool_result":
            yield {
              type: "tool-call-result",
              toolCallId: ev.toolCallId || "",
              toolName: ev.toolName || "",
              result: ev.text || "",
              duration: 0,
            };
            break;
          case "finish": {
            const u = ev.usage
              ? { promptTokens: ev.usage.inputTokens, completionTokens: ev.usage.outputTokens, totalTokens: ev.usage.inputTokens + ev.usage.outputTokens }
              : totalUsage;
            yield { type: "finish", usage: u, finishReason: "stop" };
            break;
          }
          case "error":
            yield { type: "error", error: ev.text || "stream error" };
            return;
        }
      }
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
