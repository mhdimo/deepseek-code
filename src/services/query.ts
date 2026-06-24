// Streaming query engine — ai-sdk-cpp (native C++) backend, memory-session mode.
//
// The C++ Session owns history + context management (memory auto-inject +
// sliding-window auto-compact). This module just drives session.sendStream and
// maps native events to deepseek-code's QueryEvent shape for the Ink UI.

import type { Session as BindingSession } from "ai-sdk-cpp";
import type { AgentConfig, QueryEvent, TokenUsage } from "../types/index.js";

export interface QueryParams {
  session: BindingSession;
  config: AgentConfig;
  userMessage: string;
  workingDir: string;
  abortController: AbortController;
}

export async function* query(params: QueryParams): AsyncGenerator<QueryEvent> {
  const { session, userMessage, abortController } = params;

  try {
    for await (const ev of session.sendStream(userMessage)) {
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
        case "finish": {
          const u: TokenUsage = ev.usage
            ? {
                promptTokens: ev.usage.inputTokens,
                completionTokens: ev.usage.outputTokens,
                totalTokens: ev.usage.inputTokens + ev.usage.outputTokens,
              }
            : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          yield {
            type: "finish",
            usage: u,
            cost: { inputCost: 0, outputCost: 0, totalCost: 0 },
            finishReason: "stop",
          };
          break;
        }
        case "error":
          yield { type: "error", error: ev.text || "stream error" };
          return;
      }
    }
  } catch (e) {
    yield { type: "error", error: (e as Error).message || String(e) };
  }
}
