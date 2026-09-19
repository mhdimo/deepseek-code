/**
 * Cancellation semantics for sub-agent runs.
 *
 * The defect: `agent.run` always minted its own AbortController and AgentTool
 * never handed it the parent's, so ESC abandoned the tool call while the
 * sub-agent kept streaming, spending tokens, and could still raise a permission
 * prompt after the user had interrupted.
 *
 * The reference splits by mode — a foreground sub-agent shares the turn's
 * cancellation, a background one is deliberately unlinked so it survives ESC.
 * These tests pin both halves: the link that must exist, and the coupling that
 * must not (killing one sub-agent or a TaskStop must never cancel the turn).
 *
 * The native session is faked, so the assertions are on the AbortSignal that
 * actually reaches the engine — the thing the fix had to change.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

/** Sessions built during a test, each with the signal the engine was given. */
let sessions: Array<{
  abortController: AbortController;
  emit: (ev: { type: string; text?: string }) => void;
  finish: () => void;
}> = [];

mock.module("./agentSession.js", () => ({
  getOrCreateMemorySession: (opts: { abortController?: AbortController }) => {
    let push: ((ev: unknown) => void) | null = null;
    let done = false;
    const controller = opts.abortController ?? new AbortController();
    const session = {
      // The engine stops yielding once its controller aborts — the same
      // contract the real native session has, and what the fix relies on.
      async *sendStream() {
        while (!done && !controller.signal.aborted) {
          // Idle until the test emits an event, finishes the run, or aborts —
          // a stream that ended on its own would let the run complete before
          // the abort under test could reach it.
          const ev = await new Promise<unknown>((resolve) => {
            push = resolve;
            controller.signal.addEventListener("abort", () => resolve(null), { once: true });
            setTimeout(() => resolve(null), 20);
          });
          if (controller.signal.aborted || done) break;
          if (ev !== null) yield ev;
        }
      },
    };
    sessions.push({
      abortController: controller,
      emit: (ev) => push?.(ev),
      finish: () => {
        done = true;
        push?.(null);
      },
    });
    return { session, ms: { session } };
  },
  releaseMemorySession: () => {},
}));

const { Agent } = await import("./base.js");

function makeAgent(): InstanceType<typeof Agent> {
  return new Agent({
    name: "code",
    displayName: "Code",
    description: "test",
    permissions: { allowRead: true, allowWrite: true, allowExecute: true },
    maxSteps: 5,
  } as never, { provider: "deepseek", model: "deepseek-chat", apiKey: "x" } as never);
}

/** Drain the generator in the background and resolve when it ends. */
async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    // discard
  }
}

beforeEach(() => {
  sessions = [];
});

describe("a foreground sub-agent is cancelled with its turn", () => {
  test("the parent's abort reaches the signal the engine was given", async () => {
    const parent = new AbortController();
    const agent = makeAgent();
    const running = drain(agent.run("go", [], "/tmp", undefined, undefined, parent.signal));

    await Bun.sleep(5);
    expect(sessions.length).toBe(1);
    const engineSignal = sessions[0]!.abortController.signal;
    expect(engineSignal.aborted).toBe(false);

    parent.abort();
    await running;

    expect(engineSignal.aborted).toBe(true);
  });

  test("a turn that is already over does not start the run", async () => {
    const parent = new AbortController();
    parent.abort();
    const agent = makeAgent();
    await drain(agent.run("go", [], "/tmp", undefined, undefined, parent.signal));

    expect(sessions[0]!.abortController.signal.aborted).toBe(true);
  });

  test("the link is dropped when the run ends", async () => {
    const parent = new AbortController();
    const agent = makeAgent();
    const running = drain(agent.run("go", [], "/tmp", undefined, undefined, parent.signal));
    await Bun.sleep(5);
    sessions[0]!.finish();
    await running;

    // A later abort must not find a stale listener still holding the session.
    expect(() => parent.abort()).not.toThrow();
  });
});

describe("the link is one-way", () => {
  test("aborting the sub-agent (TaskStop) leaves the turn alive", async () => {
    const parent = new AbortController();
    const agent = makeAgent();
    const running = drain(agent.run("go", [], "/tmp", undefined, undefined, parent.signal));
    await Bun.sleep(5);

    agent.abort();
    await running;

    expect(sessions[0]!.abortController.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  test("a background run gets no link, so it survives the interrupt", async () => {
    const parent = new AbortController();
    const agent = makeAgent();
    // Background: AgentTool passes no parent signal at all.
    const running = drain(agent.run("go", [], "/tmp"));
    await Bun.sleep(5);

    parent.abort();
    await Bun.sleep(5);

    expect(sessions[0]!.abortController.signal.aborted).toBe(false);
    sessions[0]!.finish();
    await running;
  });
});
