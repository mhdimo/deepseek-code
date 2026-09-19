/**
 * The context window is a contract between two processes.
 *
 * TS decides what number to hand `ai_session_create_with_memory`, and the C++
 * engine sizes its sliding window from exactly that number: it evicts turns
 * once the history passes `max_tokens - reserved_output_tokens`. Pass a number
 * larger than the provider serves and there is no compaction at all — the
 * trigger sits past the point where the API already returned 400. Pass one
 * that is too small and the engine evicts turns the session could have kept.
 * Every assertion here is about the two sides agreeing on one number.
 *
 * The number has been wrong in both directions. It started at 1,000,000, which
 * was a guess; the V3-era models served 128K, so that bought no compaction. It
 * was corrected to 128K, which was right for those models — and then V4
 * replaced them at 1M, and the correction became the bug: the app compacted a
 * million-token session at an eighth of its life and the context bar filled
 * eight times too fast.
 *
 * What settles it is the service, not the engine. The API's own validation
 * error names the output ceiling as `[1, 393216]` — 384K, the V4 figure — for
 * every model ID it answers to, `deepseek-chat` and `deepseek-reasoner`
 * included, because those are aliases for what is behind them and what is
 * behind them is V4. So the table below says 1M, and the engine's own 128K
 * fallback is not a fact about the provider: it only applies when a caller
 * passes nothing, which is a state this app is not allowed to be in.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  ContextManager,
  DEFAULT_BUDGETS,
  DEFAULT_CONTEXT_WINDOW,
  MODEL_CONTEXT_WINDOWS,
  RESERVED_OUTPUT_TOKENS,
  contextWindowFor,
} from "./contextManager.js";

/** The engine's own fallback, used only when a caller passes no window. */
const ENGINE_DEFAULT_WINDOW = 128 * 1024;
/** What V4 serves, in tokens. */
const V4_WINDOW = 1_000_000;

describe("contextWindowFor", () => {
  test("names the provider's window, not a wish", () => {
    expect(contextWindowFor("deepseek-chat")).toBe(V4_WINDOW);
    expect(contextWindowFor("deepseek-reasoner")).toBe(V4_WINDOW);
    expect(contextWindowFor("deepseek-v4-flash")).toBe(V4_WINDOW);
    expect(contextWindowFor("deepseek-v4-pro")).toBe(V4_WINDOW);
  });

  test("an unknown model still gets a window that can compact", () => {
    expect(contextWindowFor("some-future-model")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor("some-future-model")).toBe(ENGINE_DEFAULT_WINDOW);
  });

  test("no model is given a window larger than the provider serves", () => {
    for (const [model, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      expect(`${model}=${window}`).toBe(`${model}=${V4_WINDOW}`);
    }
  });

  describe("DEEPSEEK_CONTEXT_WINDOW", () => {
    const prior = process.env.DEEPSEEK_CONTEXT_WINDOW;
    afterEach(() => {
      if (prior === undefined) delete process.env.DEEPSEEK_CONTEXT_WINDOW;
      else process.env.DEEPSEEK_CONTEXT_WINDOW = prior;
    });

    test("a proxy serving more can say so", () => {
      process.env.DEEPSEEK_CONTEXT_WINDOW = "262144";
      expect(contextWindowFor("deepseek-chat")).toBe(262144);
    });

    test("nonsense falls back instead of poisoning the window", () => {
      for (const bad of ["", "0", "-1", "not-a-number", "NaN"]) {
        process.env.DEEPSEEK_CONTEXT_WINDOW = bad;
        // Falls back to the model's own entry, not to the unknown-model
        // default — a garbled override must not silently shrink a 1M model.
        expect(contextWindowFor("deepseek-chat")).toBe(V4_WINDOW);
      }
    });
  });
});

describe("budgets", () => {
  test("the reserved output mirrors the engine's own reservation", () => {
    // ContextWindow::reserved_output_tokens in the SDK. If C++ changes it, the
    // status bar has to move with it or it reports a limit that is not there.
    expect(RESERVED_OUTPUT_TOKENS).toBe(4096);
  });

  test("every budget is derived from the window it belongs to", () => {
    for (const model of Object.keys(MODEL_CONTEXT_WINDOWS)) {
      const budget = DEFAULT_BUDGETS[model]!;
      expect(budget.maxContextTokens).toBe(contextWindowFor(model));
      expect(budget.reservedForResponse).toBe(RESERVED_OUTPUT_TOKENS);
      expect(budget.compactionThreshold).toBeCloseTo(
        (budget.maxContextTokens - RESERVED_OUTPUT_TOKENS - AUTOCOMPACT_BUFFER_TOKENS) /
          budget.maxContextTokens,
        6,
      );
    }
  });

  test("the warning fires before the engine evicts, not after", () => {
    // The whole point of the threshold: a notice while the user can still act.
    // Above the trigger it announces a compaction that already happened, and
    // at the wrong window the whole schedule is off — a 128K budget on a 1M
    // model puts both numbers an eighth of the way in, which is the bug that
    // made the context bar fill up long before the session was full.
    const cm = new ContextManager("deepseek-chat");
    expect(cm.getAutoCompactThreshold()).toBeLessThan(cm.getEffectiveLimit());
    expect(cm.getAutoCompactThreshold()).toBeGreaterThan(0);
    expect(cm.getAutoCompactThreshold()).toBeLessThan(
      contextWindowFor("deepseek-chat") - RESERVED_OUTPUT_TOKENS,
    );
  });

  test("shouldWarn stays quiet below the threshold and fires once above it", () => {
    const cm = new ContextManager("deepseek-chat");
    cm.trackUsage({ totalTokens: cm.getAutoCompactThreshold() - 1 });
    expect(cm.shouldWarn()).toBe(false);
    cm.trackUsage({ totalTokens: cm.getAutoCompactThreshold() });
    expect(cm.shouldWarn()).toBe(true);
    // Once only: the warning is a notice, not a per-turn nag.
    expect(cm.shouldWarn()).toBe(false);
    cm.reset();
    expect(cm.shouldWarn()).toBe(false);
  });

  test("switching model re-derives the budget instead of keeping the old one", () => {
    const cm = new ContextManager("deepseek-chat");
    const before = cm.getBudget().maxContextTokens;
    cm.setModel("deepseek-reasoner");
    expect(cm.getBudget().maxContextTokens).toBe(before);
    cm.setModel("mystery");
    expect(cm.getBudget().maxContextTokens).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

/**
 * A window named in two places is a window that drifts. These read the sources
 * for the number that must not come back: a literal 1,000,000 standing in for a
 * window, anywhere the engine or the user is told how big the context is.
 */
describe("wiring", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

  test("the native session is given the window the app believes in", () => {
    const src = read("../components/App.tsx");
    expect(src).not.toContain("maxContextTokens: 1_000_000");
    expect(src).toContain("maxContextTokens: contextWindowFor(activeModel)");
    // The fallback session is a different model, so it gets its own window
    // rather than inheriting the primary's.
    expect(src).toContain("maxContextTokens: contextWindowFor(fallback.model ?? activeModel)");
  });

  test("headless passes it too, rather than leaving the engine on its default", () => {
    // The TUI always passed this and `--print` never did, so a headless run
    // compacted on the engine's 128K while every other surface described the
    // model's real window — the two sides of the contract disagreeing in
    // exactly the way this file exists to prevent.
    const src = read("../index.tsx");
    expect(src).not.toContain("maxContextTokens: 1_000_000");
    expect(src).toContain("maxContextTokens: contextWindowFor(config.model)");
  });

  test("no surface still reports a 1M window", () => {
    expect(read("../components/StatusBar.tsx")).toContain(
      "tokenBudget?.maxContextTokens ?? DEFAULT_CONTEXT_WINDOW",
    );
    expect(read("../utils/statusline.ts")).toContain(
      "opts.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW",
    );
    // The usage screen measures the last session against the window of the
    // model that session ran on, not against one number for all of them.
    expect(read("../components/Settings/Usage.tsx")).toContain(
      'contextWindowFor(aggregate.lastSessionModel ?? "")',
    );
  });
});
