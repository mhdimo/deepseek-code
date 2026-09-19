/**
 * What the engine's `finish` event cannot say, seen from the app.
 *
 * Two things, and both used to arrive as an ordinary successful stop:
 *
 *   - The loop is `for (step = 0; step < max_steps; ++step)` and it leaves that
 *     loop identically whether the model finished its answer or ran out of
 *     room, so "Reached max turns" could not be said, `--print` reported a
 *     truncated run as a successful one, and the TUI stopped mid-task.
 *   - A failure with no response behind it — connection refused, DNS failure,
 *     timeout — produces no error event, and the binding synthesizes a `finish`
 *     to unblock the consumer (ai-sdk-cpp bindings/node/src/addon.cpp,
 *     `RunStreamAsync`). An HTTP status is a response and surfaces normally, so
 *     this is narrower than it first looks: the engine-side cause is fixed
 *     (2664390), and this is the backstop for a build that predates it.
 *
 * The stream names each model call in its `finish`: a call whose reason is
 * `tool_calls` asked for a tool and the turn continues from there, and the
 * last one carries the turn's totals. Counting those calls against the budget
 * is what tells a bounded run from a finished one. The event that would say so
 * outright is `step_finish`, and the session path never emits one — the C
 * emitter is wired only in `ai_agent_create`, not `ai_session_send_stream`
 * (probed 2026-09-19 against the binding's mock provider: a two-call turn
 * reports two finishes and no step events). The counter used to read it
 * anyway, so it was always 0 and a run that spent its whole budget was
 * reported as a clean finish. These tests pin the mapping and the wording, and
 * the wiring that turns each into a non-zero exit.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finishReasonOf, query } from "./query.js";
import { EMPTY_FINISH_REASON } from "./recovery.js";
import { LIMIT_FINISH_REASON, reachedStepLimit, stepLimitError, stepLimitNotice } from "./stepLimit.js";
import type { AgentConfig, QueryEvent } from "../types/index.js";

const config = (maxSteps?: number): AgentConfig =>
  ({
    name: "code",
    systemPrompt: "",
    maxSteps,
    permissions: { allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: true },
  }) as AgentConfig;

/** A native session that emits exactly the given events. */
function fakeSession(events: Array<{ type: string; [k: string]: unknown }>) {
  return {
    async *sendStream() {
      for (const ev of events) yield ev;
    },
  } as never;
}

async function collect(events: Array<{ type: string; [k: string]: unknown }>, maxSteps?: number) {
  const out: QueryEvent[] = [];
  for await (const ev of query({
    session: fakeSession(events),
    config: config(maxSteps),
    userMessage: "go",
    workingDir: process.cwd(),
    abortController: new AbortController(),
  })) {
    out.push(ev);
  }
  return out;
}

const finishEvent = { type: "finish", usage: { inputTokens: 10, outputTokens: 5 } };
/** One model call that asked for a tool: the turn continues from it. */
const toolCall = { type: "finish", usage: { inputTokens: 10, outputTokens: 5, finishReason: "tool_calls" } };

describe("query finish reason", () => {
  test("a run that spent its whole budget says so", async () => {
    const events = await collect([toolCall, toolCall, toolCall, finishEvent], 3);
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe(LIMIT_FINISH_REASON);
  });

  test("a run that finished early is a normal stop", async () => {
    const events = await collect([toolCall, toolCall, finishEvent], 25);
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe("stop");
  });

  test("an agent with no budget claimed cannot be over it", async () => {
    const events = await collect([toolCall, toolCall, toolCall, toolCall, finishEvent], undefined);
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe("stop");
  });

  test("the engine's own step event is still forwarded as it happens", async () => {
    // It does not arrive on this path, and it is not counted when it does —
    // the call it describes is counted where the call is announced, on the
    // finish that ends it. Forwarding is what a future engine gets.
    const events = await collect([{ type: "step_finish" }, finishEvent], 25);
    expect(events.filter((e) => e.type === "step-finish").length).toBe(1);
  });

  test("usage survives the mapping", async () => {
    const events = await collect([finishEvent], 25);
    const finish = events.find((e) => e.type === "finish") as { usage: { totalTokens: number } };
    expect(finish.usage.totalTokens).toBe(15);
  });
});

describe("query on a turn that produced nothing", () => {
  /** What the binding synthesizes when the C call fails before streaming. */
  const silentFinish = {
    type: "finish",
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  test("a silent finish is named", async () => {
    const events = await collect([silentFinish], 25);
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe(EMPTY_FINISH_REASON);
  });

  test("output makes it an ordinary stop", async () => {
    const events = await collect(
      [{ type: "text_delta", text: "hello" }, silentFinish],
      25,
    );
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe("stop");
  });

  test("so does a tool call with no text at all", async () => {
    const events = await collect([{ type: "tool_call_start", toolName: "Read" }, silentFinish], 25);
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe("stop");
  });

  test("so does a provider that reports usage but no events", async () => {
    const events = await collect(
      [{ type: "finish", usage: { inputTokens: 900, outputTokens: 40 } }],
      25,
    );
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe("stop");
  });

  test("an empty delta is not output", async () => {
    const events = await collect([{ type: "text_delta", text: "" }, silentFinish], 25);
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe(EMPTY_FINISH_REASON);
  });

  test("running out of budget is reported as that, not as nothing", async () => {
    // Both are true of this run; the budget is the more specific thing to say.
    // It is also the shape a real bounded run leaves behind: the engine stops
    // before the next call and the stream ends without a terminal finish, so
    // the binding synthesizes one (see the probe note at the top).
    const events = await collect([toolCall, silentFinish], 1);
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe(LIMIT_FINISH_REASON);
  });
});

/**
 * A turn is one or more model calls. The engine says so twice on the wire:
 * every call ends in a `finish`, and one whose reason is `tool_calls` is the
 * model asking to run tools — the turn continues. Only the last one ends it.
 *
 * What the caller does with a finish is end-of-turn work: settling the
 * message, billing the step, firing the Stop hook, notifying the desktop.
 * Running that once per tool call is why a two-step turn billed both steps and
 * the total that already contains them, announced itself twice, and read a
 * context figure that grew with every tool it used. So a mid-turn finish is
 * not a finish here: it is the step it says it is.
 */
describe("query on a turn that took several calls", () => {
  const call = (input: number, output: number, reason: string) => ({
    type: "finish",
    usage: { inputTokens: input, outputTokens: output, finishReason: reason },
  });

  test("a one-step turn ends on its only finish", async () => {
    const events = await collect([{ type: "text_delta", text: "hi" }, call(1_000, 20, "stop")], 25);
    const finishes = events.filter((e) => e.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ finishReason: "stop", contextTokens: 1_000 });
  });

  test("a tool call is a step, not the end of the turn", async () => {
    // 20 then 27, the second being 20 plus the second call's 7 — the shape the
    // binding's own mock provider produces for a two-step turn.
    const events = await collect(
      [
        { type: "tool_call_start", toolCallId: "c1", toolName: "Bash" },
        call(20, 7, "tool_calls"),
        { type: "tool_result", toolCallId: "c1", toolName: "Bash", text: "ok" },
        { type: "text_delta", text: "done" },
        call(27, 13, "stop"),
      ],
      25,
    );

    const finishes = events.filter((e) => e.type === "finish");
    expect(finishes).toHaveLength(1);
    // 27 is what the turn spent; the window holds the last call's 7.
    expect(finishes[0]).toMatchObject({ finishReason: "stop", contextTokens: 7 });
    expect(finishes[0]).toHaveProperty("usage.totalTokens", 40);
  });

  test("the step a tool call ended still reports its own usage", async () => {
    const events = await collect([call(20, 7, "tool_calls"), call(27, 13, "stop")], 25);
    const steps = events.filter((e) => e.type === "step-finish");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toHaveProperty("stepTokens", { prompt: 20, completion: 7 });
  });

  test("a finish with no reason at all still ends the turn", async () => {
    const events = await collect([{ type: "finish" }], 25);
    const finishes = events.filter((e) => e.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ contextTokens: 0 });
  });
});

describe("finishReasonOf", () => {
  test("reads the reason the binding rides on the usage object", () => {
    expect(
      finishReasonOf({
        type: "finish",
        usage: { inputTokens: 1, outputTokens: 2, finishReason: "tool_calls" },
      } as never),
    ).toBe("tool_calls");
  });

  test("a finish with no usage, or no reason on it, has none", () => {
    // The synthetic finish the binding emits to unblock a consumer carries
    // neither, and it is not a tool call — it ends the turn.
    expect(finishReasonOf({ type: "finish" } as never)).toBe("");
    expect(
      finishReasonOf({ type: "finish", usage: { inputTokens: 1, outputTokens: 2 } } as never),
    ).toBe("");
  });
});

describe("reachedStepLimit", () => {
  test("counts the budget as spent when it is reached or passed", () => {
    expect(reachedStepLimit(3, 3)).toBe(true);
    expect(reachedStepLimit(4, 3)).toBe(true);
    expect(reachedStepLimit(2, 3)).toBe(false);
  });

  test("no budget, or a nonsense one, is no limit", () => {
    expect(reachedStepLimit(99, undefined)).toBe(false);
    expect(reachedStepLimit(99, 0)).toBe(false);
    expect(reachedStepLimit(99, -5)).toBe(false);
  });
});

describe("wording", () => {
  test("headless matches the reference's phrasing", () => {
    expect(stepLimitError(5)).toBe("Error: Reached max turns (5)");
  });

  test("the TUI says what happened and offers a way out", () => {
    const notice = stepLimitNotice(25);
    expect(notice).toContain("25");
    expect(notice).toContain("mid-task");
    expect(notice.toLowerCase()).toContain("continue");
  });
});

/**
 * The point of the finish reason is what the callers do with it. Headless
 * already prints text and exits 0 on any stream that ends without an error —
 * which is how CI read a half-finished refactor, or a rejected request, as a
 * passing run.
 */
describe("wiring", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

  test("--print reports the step limit on stderr and exits non-zero", () => {
    const print = read("../cli/print.ts");
    // Counted where the session path announces a call — on the finish that
    // ends it — not on `step_finish`, which this path never receives and which
    // is why the limit went unreported.
    expect(print).toContain("if (finishReasonOf(ev) === \"tool_calls\") steps += 1;");
    expect(print).toContain('case "step_finish"');
    expect(print).not.toContain('case "step_finish": {\n            steps += 1;');
    expect(print).toContain("reachedStepLimit(steps, agentConfig.maxSteps)");
    expect(print).toContain("stepLimitError(agentConfig.maxSteps!)");
  });

  test("--print counts each turn's calls against that turn's budget", () => {
    // `steps` used to accumulate across the notification rounds, so a long run
    // of ordinary turns could add up past a per-turn budget and be reported as
    // truncated — and the counter is only now non-zero, so this is the first
    // time it could have happened.
    const print = read("../cli/print.ts");
    expect(print).toContain("steps = 0;");
    expect(print.indexOf("steps = 0;")).toBeLessThan(print.indexOf("for await (const ev of session.sendStream("));
  });

  test("--print treats a turn that produced nothing the same way", () => {
    const print = read("../cli/print.ts");
    // --print drives the binding directly (it needs the raw stream for
    // --stream), so it counts output itself rather than going through query().
    expect(print).toContain("isEmptyTurn(usage.totalTokens, outputEvents)");
    expect(print).toContain("emptyTurnMessage(providerCfg.model)");
    // The step limit is the more specific report, so it is checked first.
    expect(print.indexOf("reachedStepLimit(steps, agentConfig.maxSteps)"))
      .toBeLessThan(print.indexOf("isEmptyTurn(usage.totalTokens, outputEvents)"));
  });

  test("both are a non-zero exit from the CLI", () => {
    const index = read("../index.tsx");
    expect(index).toContain("result.finishReason === LIMIT_FINISH_REASON");
    expect(index).toContain("result.finishReason === EMPTY_FINISH_REASON");
  });

  test("the TUI names the limit instead of going quiet", () => {
    const app = read("../components/App.tsx");
    expect(app).toContain("if (event.finishReason === LIMIT_FINISH_REASON)");
    expect(app).toContain("stepLimitNotice(maxStepsRef.current)");
    // The budget has to come from the agent that actually ran.
    expect(app).toContain("maxStepsRef.current = agentConfig.maxSteps ?? 0;");
  });

  test("and names the empty turn too", () => {
    const app = read("../components/App.tsx");
    expect(app).toContain("if (event.finishReason === EMPTY_FINISH_REASON)");
    expect(app).toContain("emptyTurnMessage(activeModel)");
  });

  test("an overloaded provider shows what it said, not just the advice", () => {
    // The advice replaces the error text in the transcript, so the provider's
    // own message has to be carried into it explicitly.
    const app = read("../components/App.tsx");
    expect(app).toContain("overloadMessage(activeModel, errorText)");
    expect(app).toContain("overloadMessage(fallback.model ?? activeModel, retryRaw)");
    expect(app).toContain("promptTooLongMessage(errorText)");
    expect(app).toContain("promptTooLongMessage(raw)");
  });
});
