/**
 * Wiring test for the Agent tool's cancellation handoff.
 *
 * base.ts correctly links a run to its parent signal when given one — that is
 * covered in services/agent/abortLink.test.ts. The original defect was one
 * layer up: AgentTool never passed it, so the link existed and nothing used it.
 * These tests call the real AgentTool.call and assert on what the sub-agent was
 * actually handed, per mode.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

interface RunCall {
  prompt: string;
  parentSignal: AbortSignal | undefined;
}

let runCalls: RunCall[] = [];

mock.module("../../services/agent/index.js", () => ({
  agentManager: {
    resolveConfig: (name: string) => ({
      name,
      displayName: name,
      description: "test agent",
      permissions: { allowRead: true, allowWrite: false, allowExecute: false },
      maxSteps: 3,
    }),
    listAgentNames: () => ["code", "plan"],
    createAgent: () => ({
      // Async generator, matching the real Agent.run signature shape: the tool
      // drains it, and the 6th argument is the parent signal under test.
      async *run(
        prompt: string,
        _history: unknown,
        _workingDir: string,
        _requestPermission: unknown,
        _onToolActivity: unknown,
        parentSignal?: AbortSignal,
      ) {
        runCalls.push({ prompt, parentSignal });
        return;
      },
      abort: () => {},
    }),
  },
}));

const { AgentTool } = await import("./AgentTool.js");

async function callAgent(
  args: Record<string, unknown>,
  context: { abortController: AbortController },
): Promise<string> {
  const result = await (AgentTool as never as {
    call: (a: unknown, c: unknown) => Promise<{ data: unknown }>;
  }).call(args, {
    workingDir: "/tmp",
    permissions: { allowRead: true, allowWrite: false, allowExecute: false },
    requestPermission: () => Promise.resolve({ approved: true }),
    onToolOutput: () => {},
    onSystemMessage: () => {},
    ...context,
  });
  return String(result.data);
}

beforeEach(() => {
  runCalls = [];
});

describe("AgentTool links a foreground run to the turn", () => {
  test("the parent's signal is handed to the sub-agent", async () => {
    const parent = new AbortController();
    await callAgent(
      { prompt: "look around", subagent_type: "plan" },
      { abortController: parent },
    );

    expect(runCalls.length).toBe(1);
    expect(runCalls[0]!.parentSignal).toBe(parent.signal);
  });

  test("an interrupted turn stops the sub-agent instead of orphaning it", async () => {
    const parent = new AbortController();
    const running = callAgent(
      { prompt: "look around", subagent_type: "plan" },
      { abortController: parent },
    );
    // The turn is interrupted while the sub-agent is in flight.
    parent.abort();

    const out = await running;
    expect(runCalls[0]!.parentSignal?.aborted).toBe(true);
    // And the result does not read as a completed run.
    expect(out).toContain("interrupted");
  });
});

describe("AgentTool leaves a background run unlinked", () => {
  test("no parent signal is passed, so it survives the interrupt", async () => {
    const parent = new AbortController();
    const out = await callAgent(
      { prompt: "long job", subagent_type: "plan", run_in_background: true },
      { abortController: parent },
    );

    expect(runCalls.length).toBe(1);
    expect(runCalls[0]!.parentSignal).toBeUndefined();
    expect(out).toContain("Background agent launched");
  });
});
