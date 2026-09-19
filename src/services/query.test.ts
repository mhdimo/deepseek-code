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
 * The stream carries one step per model call and one event per piece of output,
 * so both are countable. These tests pin the mapping and the wording, and the
 * wiring that turns each into a non-zero exit.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "./query.js";
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
const step = { type: "step_finish" };

describe("query finish reason", () => {
  test("a run that spent its whole budget says so", async () => {
    const events = await collect([step, step, step, finishEvent], 3);
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe(LIMIT_FINISH_REASON);
  });

  test("a run that finished early is a normal stop", async () => {
    const events = await collect([step, step, finishEvent], 25);
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe("stop");
  });

  test("an agent with no budget claimed cannot be over it", async () => {
    const events = await collect([step, step, step, step, finishEvent], undefined);
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe("stop");
  });

  test("steps are still forwarded as they happen", async () => {
    const events = await collect([step, step, finishEvent], 25);
    expect(events.filter((e) => e.type === "step-finish").length).toBe(2);
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
    const events = await collect([step, silentFinish], 1);
    const finish = events.find((e) => e.type === "finish") as { finishReason: string };
    expect(finish.finishReason).toBe(LIMIT_FINISH_REASON);
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
    expect(print).toContain("case \"step_finish\": {");
    expect(print).toContain("reachedStepLimit(steps, agentConfig.maxSteps)");
    expect(print).toContain("stepLimitError(agentConfig.maxSteps!)");
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
