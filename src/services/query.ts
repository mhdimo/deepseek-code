// Streaming query engine — ai-sdk-cpp (native C++) backend.
//
// The C++ agent loop now owns the multi-step tool loop: it calls the model,
// executes tools (via the async-tool bridge — so interactive permissions work),
// and streams events. This module maps those native events to deepseek-code's
// QueryEvent shape (what the Ink UI consumes) and handles TS-side history +
// context compaction. Retry / token-cost / todo-state parity are follow-ups.

import { streamText as bindingStreamText, type Model as BindingModel } from "ai-sdk-cpp";
import type {
  AgentConfig,
  Message,
  QueryEvent,
  TokenUsage,
} from "../types/index.js";
import { getTools, toolsToBindingFormat } from "../tools.js";
import type { ToolUseContext, PermissionCallback } from "../Tool.js";

// Loose subsets of TokenTracker / ContextManager (structural typing — the real
// classes are supersets and remain assignable).
interface QueryTokenTracker {
  addUsage(u: TokenUsage): void;
}
interface QueryContextManager {
  prepareForAPI(m: Message[]): Message[];
  needsCompaction(m: Message[]): boolean;
  compact(m: Message[]): { before: number; after: number; messages: Message[] };
}

export interface QueryParams {
  model: BindingModel;
  config: AgentConfig;
  userMessage: string;
  history: Message[];
  workingDir: string;
  abortController: AbortController;
  requestPermission?: PermissionCallback;
  tokenTracker?: QueryTokenTracker;
  contextManager?: QueryContextManager;
}

function toApiMessages(history: Message[], userMessage: string): Array<{ role: string; content: string }> {
  const msgs = history
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  msgs.push({ role: "user", content: userMessage });
  return msgs;
}

export async function* query(params: QueryParams): AsyncGenerator<QueryEvent> {
  const {
    model, config, userMessage, history, workingDir, abortController,
    requestPermission, tokenTracker, contextManager,
  } = params;

  // Per-query tool context. Mutable shared state (todos/tasks/planMode) is
  // stubbed for now — wiring the real App state through is a follow-up.
  const toolContext: ToolUseContext = {
    workingDir,
    permissions: config.permissions,
    abortController,
    requestPermission: requestPermission ?? (async () => ({ approved: true })),
    messages: history,
    lastPermissionWaitMs: 0,
    recordPermissionWait: () => {},
    consumePermissionWaitMs: () => 0,
    getTodos: () => [],
    setTodos: () => {},
    getTasks: () => [],
    setTasks: () => {},
    getPlanMode: () => false,
    setPlanMode: () => {},
  };
  const tools = toolsToBindingFormat(getTools(config.permissions), toolContext);

  // Auto-compaction (TS-side; the C++ gets the already-compacted history).
  let baseHistory = history;
  if (contextManager && contextManager.needsCompaction(history)) {
    const c = contextManager.compact(history);
    if (c.before > c.after) {
      baseHistory = c.messages;
      yield {
        type: "compact",
        reason: "Context approaching token limit",
        messagesBefore: c.before,
        messagesAfter: c.after,
      };
    }
  }

  const prepared = contextManager ? contextManager.prepareForAPI(baseHistory) : baseHistory;
  const apiMessages = toApiMessages(prepared, userMessage);

  // NOTE: the native finish event currently carries no token usage, so usage
  // stays zero here until the binding surfaces it. Cost/token parity = follow-up.
  const total: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const zeroCost = { inputCost: 0, outputCost: 0, totalCost: 0 };

  try {
    for await (const ev of bindingStreamText({
      model,
      system: config.systemPrompt,
      messages: apiMessages,
      tools,
      maxSteps: config.maxSteps || 25,
      temperature: config.temperature,
      maxOutputTokens: config.maxTokens,
    })) {
      if (abortController.signal.aborted) break;
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
        case "finish":
          tokenTracker?.addUsage(total);
          yield { type: "finish", usage: total, cost: zeroCost, finishReason: "stop" };
          break;
        case "error":
          yield { type: "error", error: ev.text || "stream error" };
          return;
      }
    }
  } catch (e) {
    yield { type: "error", error: (e as Error).message || String(e) };
  }
}
