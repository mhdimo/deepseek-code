





import type { Session as BindingSession, StreamEvent } from "ai-sdk-cpp";
import type { AgentConfig, QueryEvent, TokenUsage } from "../types/index.js";
import { TurnUsage } from "./contextUsage.js";
import { costForTokens } from "./tokenTracker.js";
import { EMPTY_FINISH_REASON, isEmptyTurn } from "./recovery.js";
import { LIMIT_FINISH_REASON, reachedStepLimit } from "./stepLimit.js";

/** The model's reason for a finish, as the binding passes it through.
 *
 *  `StreamEvent['usage']` declares the token counts only, but `finishReason`
 *  rides alongside them — the node addon sets it on the same object, and the
 *  binding's own stream loop keys the end of a turn off it. Reading it is the
 *  only way to tell a step from a turn, and the only per-call signal the
 *  session path sends at all (`step_finish` never arrives here, so `--print`
 *  counts with this too). */
export function finishReasonOf(ev: StreamEvent): string {
  return (ev.usage as { finishReason?: string } | undefined)?.finishReason ?? "";
}

export interface QueryParams {
  session: BindingSession;
  config: AgentConfig;
  /** The model this session runs on — what prices the turn's cost. Absent
   *  (tests, minimal callers) prices at the conservative default rate. */
  model?: string;
  userMessage: string;
  workingDir: string;
  abortController: AbortController;
}

export async function* query(params: QueryParams): AsyncGenerator<QueryEvent> {
  const { session, config, model, userMessage, abortController } = params;

  // The engine's `finish` event cannot say whether the loop stopped because
  // the model was done or because it ran out of steps, so count the steps —
  // the one signal the stream does carry — and report the difference.
  let steps = 0;
  // …and it cannot say whether anything came back at all: a request rejected
  // before its first stream part and a completed empty turn are the same
  // `finish`. Count the model's own output so the two can be told apart.
  let outputEvents = 0;
  // A turn is one or more model calls, and each one ends in a finish of its
  // own. This tracks what the turn has spent so far, so the last call's input
  // — the size of the conversation as it now stands — can be told from the
  // turn's total. See services/contextUsage.ts.
  const turn = new TurnUsage();

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
          // Forwarded, not counted: the call it describes is counted where the
          // call is announced — see the mid-turn finish below. Counting both
          // would count one call twice if this ever starts arriving.
          yield {
            type: "step-finish",
            stepTokens: { prompt: 0, completion: 0 },
          };
          break;
        case "finish": {
          const input = ev.usage?.inputTokens ?? 0;
          const output = ev.usage?.outputTokens ?? 0;
          // Not every finish ends the turn. One whose reason is `tool_calls` is
          // the model asking to run tools, and the loop answers it with another
          // call — a step, not a turn. Its usage is that step's own, and in the
          // session path it is the only per-step figure that ever arrives: the
          // engine emits no `step_finish` here. Reporting it as a finish would
          // end the turn early and bill the step twice.
          if (finishReasonOf(ev) === "tool_calls") {
            // One more model call behind us, so one more step toward the
            // budget. This is the count `reachedStepLimit` reads: a run that
            // spends its whole budget stops here and the stream simply ends,
            // which is why the count and not the finish's reason is what says
            // so.
            steps += 1;
            turn.step(input);
            yield { type: "step-finish", stepTokens: { prompt: input, completion: output } };
            break;
          }
          const u: TokenUsage = {
            promptTokens: input,
            completionTokens: output,
            totalTokens: input + output,
          };
          const { inputCost, outputCost } = costForTokens(
            model ?? "",
            u.promptTokens,
            u.completionTokens,
          );
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
            // What the turn leaves behind: the last call's input, which is the
            // conversation as the next request would send it. See
            // services/contextUsage.ts.
            contextTokens: turn.finish(input),
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
