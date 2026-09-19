





import type { Session as BindingSession } from "ai-sdk-cpp";
import type { AgentConfig, QueryEvent, TokenUsage } from "../types/index.js";
import { EMPTY_FINISH_REASON, isEmptyTurn } from "./recovery.js";
import { LIMIT_FINISH_REASON, reachedStepLimit } from "./stepLimit.js";

export interface QueryParams {
  session: BindingSession;
  config: AgentConfig;
  userMessage: string;
  workingDir: string;
  abortController: AbortController;
}

export async function* query(params: QueryParams): AsyncGenerator<QueryEvent> {
  const { session, config, userMessage, abortController } = params;

  // The engine's `finish` event cannot say whether the loop stopped because
  // the model was done or because it ran out of steps, so count the steps —
  // the one signal the stream does carry — and report the difference.
  let steps = 0;
  // …and it cannot say whether anything came back at all: a request rejected
  // before its first stream part and a completed empty turn are the same
  // `finish`. Count the model's own output so the two can be told apart.
  let outputEvents = 0;

  try {
    for await (const ev of session.sendStream(userMessage)) {
      if (abortController.signal.aborted) break;
      switch (ev.type) {
        case "text_delta":
          if (ev.text) outputEvents += 1;
          yield { type: "text-delta", text: ev.text || "" };
          break;
        case "reasoning_start":
          yield { type: "thinking-start" };
          break;
        case "reasoning_delta":
          yield { type: "thinking-delta", text: ev.text || "" };
          break;
        case "reasoning_end":
          yield { type: "thinking-end" };
          break;
        case "tool_call_start":
          outputEvents += 1;
          yield {
            type: "tool-call-start",
            toolCallId: ev.toolCallId || "",
            toolName: ev.toolName || "",
            args: {},
          };
          break;
        case "tool_call_delta":
          yield {
            type: "tool-call-delta",
            toolCallId: ev.toolCallId || "",
            toolName: ev.toolName || "",
            text: ev.text || "",
          };
          break;
        case "tool_call_end":
          yield {
            type: "tool-call-end",
            toolCallId: ev.toolCallId || "",
            toolName: ev.toolName || "",
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
        case "step_finish":
          steps += 1;
          yield {
            type: "step-finish",
            stepTokens: { prompt: 0, completion: 0 },
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
          
          const inputCost = (u.promptTokens / 1_000_000) * 0.27;
          const outputCost = (u.completionTokens / 1_000_000) * 1.10;
          // A run that used its whole budget is reported as that first: it is
          // the more specific thing to say about it.
          const finishReason = reachedStepLimit(steps, config.maxSteps)
            ? LIMIT_FINISH_REASON
            : isEmptyTurn(u.totalTokens, outputEvents)
              ? EMPTY_FINISH_REASON
              : "stop";
          yield {
            type: "finish",
            usage: u,
            cost: { inputCost, outputCost, totalCost: inputCost + outputCost },
            finishReason,
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
