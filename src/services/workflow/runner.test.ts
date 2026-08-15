import { beforeEach, describe, expect, mock, test } from "bun:test";
const mockModule = mock.module;
import type { Workflow } from "./workflowService.js";

/**
 * Hermetic runner tests: agentManager + the background-task registry are
 * mocked so the run loop executes against fake step agents (no network).
 */

const taskStates = new Map<string, Record<string, unknown>>();
const outputs: string[] = [];
const stateUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
let createAgentImpl: () => unknown = () => {
  throw new Error("createAgent not wired for this test");
};

mockModule("/Users/liang/deepseek-code/src/services/agent/index.js", () => ({
  agentManager: {
    createAgent: () => createAgentImpl(),
  },
}));

mockModule("/Users/liang/deepseek-code/src/services/tasks/backgroundFramework.js", () => ({
  registerVirtualTask: (type: string, command: string, opts: Record<string, unknown> = {}) => {
    const id = `w-test-${taskStates.size + 1}`;
    taskStates.set(id, { id, type, status: "running", command, ...opts });
    return taskStates.get(id);
  },
  appendTaskOutput: (_id: string, text: string) => {
    outputs.push(text);
  },
  updateTaskState: (id: string, patch: Record<string, unknown>) => {
    stateUpdates.push({ id, patch });
    taskStates.set(id, { ...taskStates.get(id), ...patch });
    return taskStates.get(id);
  },
  getTask: (id: string) => taskStates.get(id),
}));

const { getWorkflowRun, retryWorkflowStep, skipWorkflowStep, startWorkflowRun, workflowRunFailed } = await import(
  "/Users/liang/deepseek-code/src/services/workflow/runner.ts"
);

const WORKFLOW: Workflow = {
  name: "test-wf",
  description: "fixture",
  path: "/tmp/fixture.md",
  source: "project",
  phases: [
    {
      title: "One",
      steps: [
        { agent: "plan", name: "first", prompt: "do {input}" },
        { agent: "code", name: "second", prompt: "use {1.result}" },
      ],
    },
    {
      title: "Two",
      steps: [{ agent: "review", name: "third", prompt: "review {second.result}" }],
    },
  ],
};

const OPTS = {
  providerConfig: { type: "deepseek" as const, apiKey: "test", baseURL: "http://localhost" },
  workingDir: "/tmp",
};

/** Step agent whose run() holds on a gate the test releases. */
function gatedAgent() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const agent = {
    abort: mock(() => {}),
    run: mock(async function* () {
      await gate;
      yield { type: "tool-call-start", toolCallId: "t1", toolName: "Bash", args: {} };
      yield { type: "text-delta", text: "fixture result" };
    }),
  };
  return { agent, release };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await Bun.sleep(5);
  }
}

beforeEach(() => {
  taskStates.clear();
  outputs.length = 0;
  stateUpdates.length = 0;
  createAgentImpl = () => {
    throw new Error("createAgent not wired for this test");
  };
});

describe("workflowRunFailed", () => {
  test("true when any step failed, false for done/skipped", () => {
    const base = {
      taskId: "x",
      workflowName: "w",
      input: "",
      startedAt: 0,
      finished: true,
      results: new Map<string, string>(),
      providerConfig: OPTS.providerConfig,
      workingDir: "/tmp",
    };
    const step = (status: "pending" | "running" | "done" | "failed" | "skipped") => ({
      number: 1,
      phaseIndex: 0,
      stepName: "s",
      agentType: "code" as const,
      rawPrompt: "p",
      status,
      retryCount: 0,
    });
    expect(
      workflowRunFailed({
        ...base,
        phases: [{ title: "P", steps: [step("done"), step("skipped")] }],
      }),
    ).toBe(false);
    expect(
      workflowRunFailed({
        ...base,
        phases: [{ title: "P", steps: [step("done"), step("failed")] }],
      }),
    ).toBe(true);
  });
});

describe("startWorkflowRun with fake agents", () => {
  test("runs phases sequentially, fills results and finishes done", async () => {
    const { agent, release } = gatedAgent();
    createAgentImpl = () => agent;
    const taskId = startWorkflowRun(WORKFLOW, "hello", OPTS);
    release();

    await waitFor(() => getWorkflowRun(taskId)?.finished === true, 500);
    const run = getWorkflowRun(taskId)!;
    const steps = run.phases.flatMap((p) => p.steps);

    expect(steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(steps.map((s) => s.retryCount)).toEqual([0, 0, 0]);
    expect(run.results.get("1")).toBe("fixture result");
    expect(run.results.get("first")).toBe("fixture result");
    expect(run.results.get("second")).toBe("fixture result");
    expect(workflowRunFailed(run)).toBe(false);
    expect(stateUpdates.some((u) => u.patch.status === "done")).toBe(true);
    expect(outputs.join("")).toContain("── Phase 1/2: One ──");
    expect(outputs.join("")).toContain("✓ Workflow finished");
    release();
  });

  test("skip of a pending (not yet launched) step", async () => {
    const { agent, release } = gatedAgent();
    createAgentImpl = () => agent;
    const taskId = startWorkflowRun(WORKFLOW, "", OPTS);

    // Phase 1 steps are already running (gated); step 3 is still pending.
    const skip = skipWorkflowStep(taskId, 3);
    expect(skip.ok).toBe(true);
    expect(skip.message).toContain("step 3");

    release();
    await waitFor(() => getWorkflowRun(taskId)?.finished === true, 500);
    const run = getWorkflowRun(taskId)!;
    const steps = run.phases.flatMap((p) => p.steps);

    expect(steps[2]!.status).toBe("skipped");
    expect(agent.run.mock.calls.length).toBe(2); // only steps 1+2 launched
    expect(workflowRunFailed(run)).toBe(false);
    expect(outputs.join("")).toContain("third (review) skipped");
  });

  test("skip of a running step aborts its agent and reads as skipped", async () => {
    const { agent, release } = gatedAgent();
    createAgentImpl = () => agent;
    const taskId = startWorkflowRun(WORKFLOW, "", OPTS);

    const skip = skipWorkflowStep(taskId, 1);
    expect(skip.ok).toBe(true);
    expect(agent.abort.mock.calls.length).toBe(1);

    release();
    await waitFor(() => getWorkflowRun(taskId)?.finished === true, 500);
    const run = getWorkflowRun(taskId)!;
    const steps = run.phases.flatMap((p) => p.steps);

    expect(steps[0]!.status).toBe("skipped");
    expect(steps[1]!.status).toBe("done");
    expect(run.results.has("1")).toBe(false); // skipped result not indexed
    expect(outputs.join("")).toContain("⊘ first: skipped by user");
  });

  test("retry re-runs a failed step with its original prompt and reconciles the task", async () => {
    const { agent, release } = gatedAgent();
    createAgentImpl = () => agent;
    const taskId = startWorkflowRun(WORKFLOW, "", OPTS);
    release();
    await waitFor(() => getWorkflowRun(taskId)?.finished === true, 500);

    // Force step 1 to a failed state (simulating a user-visible failure).
    const run = getWorkflowRun(taskId)!;
    run.phases[0]!.steps[0]!.status = "failed";

    const retry = retryWorkflowStep(taskId, 1);
    expect(retry.ok).toBe(true);
    expect(retry.message).toContain("step 1");
    await waitFor(() => getWorkflowRun(taskId)!.phases[0]!.steps[0]!.status === "done", 500);

    const step = getWorkflowRun(taskId)!.phases[0]!.steps[0]!;
    expect(step.status).toBe("done");
    expect(step.retryCount).toBe(1);
    expect(step.prompt).toBe("do "); // original substituted prompt
    expect(outputs.join("")).toContain("retry first (plan)");
    expect(stateUpdates.some((u) => u.patch.status === "running")).toBe(true);
    expect(stateUpdates.some((u) => u.patch.status === "done")).toBe(true);
  });

  test("refusals: retry while running, skip after finish", async () => {
    const { agent, release } = gatedAgent();
    createAgentImpl = () => agent;
    const taskId = startWorkflowRun(WORKFLOW, "", OPTS);

    const whileRunning = retryWorkflowStep(taskId, 1);
    expect(whileRunning.ok).toBe(false);
    expect(whileRunning.message).toContain("still running");

    release();
    await waitFor(() => getWorkflowRun(taskId)?.finished === true, 500);

    const afterFinish = skipWorkflowStep(taskId, 1);
    expect(afterFinish.ok).toBe(false);
    expect(afterFinish.message).toContain("already finished");
  });
});
