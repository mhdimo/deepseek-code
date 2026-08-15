
import { agentManager } from "../agent/index.js";
import type { Agent } from "../agent/index.js";
import type { PermissionCallback } from "../../Tool.js";
import type { ProviderConfig } from "../../types/index.js";
import { isTerminalTaskStatus } from "../../Task.js";
import {
  appendTaskOutput,
  getTask,
  registerVirtualTask,
  updateTaskState,
} from "../tasks/backgroundFramework.js";
import { flattenSteps, substituteVars, type Workflow, type WorkflowStep } from "./workflowService.js";

/**
 * Workflow execution — ported from Claude Code's LocalWorkflowTask model:
 * each run registers as a killable background task; phases run sequentially,
 * steps within a phase run in parallel as subagents; progress streams to the
 * task's output file (the /tasks view and TaskOutput read it live).
 *
 * Per-step control: every run keeps a module-level record of phase/step
 * statuses plus live agent handles, so the UI can skip a step (`s`) or retry
 * a finished one (`r`) through skipWorkflowStep()/retryWorkflowStep().
 */

export interface WorkflowRunOptions {
  providerConfig: ProviderConfig;
  workingDir: string;
  requestPermission?: PermissionCallback;
  /** UI notification hook (completion / failure). */
  onSystemMessage?: (content: string) => void;
}

export type WorkflowStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface WorkflowStepRecord {
  /** 1-based across the whole workflow (matches {N.result} indexing). */
  number: number;
  phaseIndex: number;
  /** name ?? `step${number}` — the label shown in output/UI. */
  stepName: string;
  agentType: WorkflowStep["agent"];
  /** Unsubstituted prompt from the workflow file. */
  rawPrompt: string;
  /** Prompt as substituted at first launch — retries re-run with this. */
  prompt?: string;
  status: WorkflowStepStatus;
  toolUses?: number;
  error?: string;
  retryCount: number;
  /** Live handle while the step agent is running (abort for skip/kill). */
  agent?: Agent;
  /** Explicit step name lowercased — result-map key alongside the number. */
  nameKey?: string;
}

export interface WorkflowPhaseRecord {
  title: string;
  steps: WorkflowStepRecord[];
}

export interface WorkflowRunRecord {
  taskId: string;
  workflowName: string;
  input: string;
  startedAt: number;
  finished: boolean;
  phases: WorkflowPhaseRecord[];
  results: Map<string, string>;
  providerConfig: ProviderConfig;
  workingDir: string;
  requestPermission?: PermissionCallback;
}

/** taskId → run record; kept past completion so the /tasks detail view can
 *  show step statuses (and retry) while the run is being reviewed. */
const runs = new Map<string, WorkflowRunRecord>();

export interface WorkflowActionResult {
  ok: boolean;
  message: string;
}

/** Structured step statuses for the /tasks workflow detail pane. */
export function getWorkflowRun(taskId: string): WorkflowRunRecord | undefined {
  return runs.get(taskId);
}

function findStep(run: WorkflowRunRecord, stepNumber: number): WorkflowStepRecord | undefined {
  for (const phase of run.phases) {
    const step = phase.steps.find((s) => s.number === stepNumber);
    if (step) return step;
  }
  return undefined;
}

/** Any step across the run failed (skips don't count) — drives the final
 *  task status and the post-retry reconciliation. */
export function workflowRunFailed(run: WorkflowRunRecord): boolean {
  for (const phase of run.phases) {
    for (const step of phase.steps) {
      if (step.status === "failed") return true;
    }
  }
  return false;
}

function abortRunAgents(run: WorkflowRunRecord): void {
  for (const phase of run.phases) {
    for (const step of phase.steps) {
      step.agent?.abort();
    }
  }
}

/** Request skipping a step of a running workflow: pending steps never
 *  launch; running steps are aborted and counted as skipped (not failed). */
export function skipWorkflowStep(taskId: string, stepNumber: number): WorkflowActionResult {
  const run = runs.get(taskId);
  if (!run) return { ok: false, message: `No workflow run with task id '${taskId}'.` };
  const step = findStep(run, stepNumber);
  if (!step) return { ok: false, message: `No step ${stepNumber} in this workflow run.` };
  if (run.finished) return { ok: false, message: "Workflow run already finished — step can't be skipped." };
  if (step.status === "running") {
    step.agent?.abort();
    step.status = "skipped";
    appendTaskOutput(taskId, `  │   ⊘ ${step.stepName}: skipped by user\n`);
    return { ok: true, message: `Skipped step ${stepNumber} (${step.stepName}).` };
  }
  if (step.status === "pending") {
    step.status = "skipped";
    appendTaskOutput(taskId, `  ├─ ${step.stepName} (${step.agentType}) skipped\n`);
    return { ok: true, message: `Skipped step ${stepNumber} (${step.stepName}).` };
  }
  return { ok: false, message: `Step ${stepNumber} is already ${step.status} — can't skip it.` };
}

/** Re-run a finished (done/failed/skipped) step with its original prompt.
 *  If the whole run already concluded, the task is reopened and its final
 *  status is re-derived from the updated records. */
export function retryWorkflowStep(taskId: string, stepNumber: number): WorkflowActionResult {
  const run = runs.get(taskId);
  if (!run) return { ok: false, message: `No workflow run with task id '${taskId}'.` };
  const step = findStep(run, stepNumber);
  if (!step) return { ok: false, message: `No step ${stepNumber} in this workflow run.` };
  if (step.status === "running" || step.status === "pending") {
    return { ok: false, message: `Step ${stepNumber} is still ${step.status} — wait for it to finish first.` };
  }
  void retryStep(run, step);
  return { ok: true, message: `Retrying step ${stepNumber} (${step.stepName}).` };
}

async function retryStep(run: WorkflowRunRecord, step: WorkflowStepRecord): Promise<void> {
  const { taskId } = run;
  step.retryCount++;
  step.status = "running";
  // The run may have concluded (or been killed) while this step was
  // terminal — reopen the task so its status tracks the retry; it is
  // re-concluded on completion below (the main loop is long gone by then).
  const current = getTask(taskId);
  const reopened = current !== undefined && isTerminalTaskStatus(current.status);
  if (reopened) {
    updateTaskState(taskId, { status: "running" });
  }
  appendTaskOutput(taskId, `  ├─ retry ${step.stepName} (${step.agentType}) running…\n`);
  const prompt = step.prompt ?? substituteVars(step.rawPrompt, { input: run.input, results: run.results });
  step.prompt = prompt;
  const agent = agentManager.createAgent(step.agentType, run.providerConfig);
  step.agent = agent;
  const { response, toolUses, error } = await runStep(agent, prompt, run.workingDir, run.requestPermission);
  step.agent = undefined;
  const ok = !error;
  step.status = ok ? "done" : "failed";
  step.toolUses = toolUses;
  step.error = error ?? undefined;
  if (ok) {
    run.results.set(String(step.number), response);
    if (step.nameKey) run.results.set(step.nameKey, response);
  }
  appendTaskOutput(
    taskId,
    `  │   ${ok ? "✓" : "✗"} retry ${step.stepName}: ${toolUses} tool use${toolUses === 1 ? "" : "s"}${error ? ` — ${error}` : ""}\n`,
  );
  if (reopened || run.finished) {
    const failed = workflowRunFailed(run);
    updateTaskState(
      taskId,
      failed
        ? { status: "error", endedAt: Date.now(), error: "One or more workflow steps failed." }
        : { status: "done", endedAt: Date.now(), exitCode: 0 },
    );
    appendTaskOutput(
      taskId,
      `\n${failed ? "✗ Workflow still has failing steps" : "✓ All steps passed after retry"} — re-check /tasks.\n`,
    );
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

interface StepOutcome {
  number: number;
  label: string;
  ok: boolean;
  skipped: boolean;
  response: string;
  toolUses: number;
}

async function runStep(
  agent: Agent,
  prompt: string,
  workingDir: string,
  requestPermission: PermissionCallback | undefined,
): Promise<{ response: string; toolUses: number; error: string | null }> {
  let response = "";
  let toolUses = 0;
  let error: string | null = null;
  try {
    for await (const ev of agent.run(prompt, [], workingDir, requestPermission)) {
      if (ev.type === "text-delta") {
        response += ev.text;
      } else if (ev.type === "tool-call-start") {
        toolUses++;
      } else if (ev.type === "error") {
        error = ev.error;
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }
  return { response, toolUses, error };
}

/** Launch one step through its run record: honors a pre-launch skip request,
 *  aborts its agent if skip lands mid-run (yielding an aborted agent.run →
 *  error event, which reads as skipped, not failed), and publishes the
 *  outcome into both the record and the {N.result} map. */
async function runStepInRun(
  taskId: string,
  run: WorkflowRunRecord,
  step: WorkflowStepRecord,
  opts: WorkflowRunOptions,
): Promise<StepOutcome> {
  if (step.status === "skipped") {
    appendTaskOutput(taskId, `  ├─ ${step.stepName} (${step.agentType}) skipped\n`);
    return { number: step.number, label: step.stepName, ok: true, skipped: true, response: "", toolUses: 0 };
  }
  // Substitute at launch so {N.result}/{name.result} refs see earlier
  // phases' results; the stored prompt is what retries re-run with.
  if (step.prompt === undefined) {
    step.prompt = substituteVars(step.rawPrompt, { input: run.input, results: run.results });
  }
  const agent = agentManager.createAgent(step.agentType, opts.providerConfig);
  step.agent = agent;
  step.status = "running";
  appendTaskOutput(taskId, `  ├─ ${step.stepName} (${step.agentType}) running…\n`);
  const { response, toolUses, error } = await runStep(agent, step.prompt, opts.workingDir, opts.requestPermission);
  step.agent = undefined;
  // TS narrows step.status to "running" past the await; re-read as the full
  // union — a skip request may have flipped it to "skipped" mid-run.
  const skipped = (step.status as WorkflowStepStatus) === "skipped";
  const ok = skipped || !error;
  step.status = skipped ? "skipped" : ok ? "done" : "failed";
  step.toolUses = toolUses;
  step.error = error ?? undefined;
  appendTaskOutput(
    taskId,
    `  │   ${ok ? (skipped ? "⊘" : "✓") : "✗"} ${step.stepName}: ${toolUses} tool use${toolUses === 1 ? "" : "s"}${
      !skipped && error ? ` — ${error}` : ""
    }\n`,
  );
  if (!skipped) {
    run.results.set(String(step.number), response);
    if (step.nameKey) run.results.set(step.nameKey, response);
  }
  return { number: step.number, label: step.stepName, ok, skipped, response, toolUses };
}

/** Kick off a workflow as a background task. Returns the task id. */
export function startWorkflowRun(
  workflow: Workflow,
  input: string,
  opts: WorkflowRunOptions,
): string {
  const started = Date.now();
  const allSteps = flattenSteps(workflow);
  // `let` so the onKill closure (fired after registration returns) can see it.
  let run: WorkflowRunRecord | undefined;
  const task = registerVirtualTask("workflow", `workflow ${workflow.name}: ${input.slice(0, 50) || "(no args)"}`, {
    onKill: () => {
      if (run) abortRunAgents(run);
    },
    name: workflow.name,
    description: input.slice(0, 50) || "(no args)",
    prompt: input,
  });

  const results = new Map<string, string>();
  run = {
    taskId: task.id,
    workflowName: workflow.name,
    input,
    startedAt: started,
    finished: false,
    phases: workflow.phases.map((phase, phaseIdx) => ({
      title: phase.title,
      steps: phase.steps.map((stepMeta) => {
        const meta = allSteps.find((s) => s.step === stepMeta)!;
        return {
          number: meta.number,
          phaseIndex: phaseIdx,
          stepName: stepMeta.name ?? `step${meta.number}`,
          agentType: stepMeta.agent,
          rawPrompt: stepMeta.prompt,
          status: "pending" as const,
          retryCount: 0,
          nameKey: stepMeta.name?.toLowerCase(),
        };
      }),
    })),
    results,
    providerConfig: opts.providerConfig,
    workingDir: opts.workingDir,
    requestPermission: opts.requestPermission,
  };
  runs.set(task.id, run);

  void (async () => {
    appendTaskOutput(
      task.id,
      `Workflow: ${workflow.name}\nArgs: ${input || "(none)"}\nSteps: ${allSteps.length} across ${workflow.phases.length} phase(s)\n\n`,
    );

    for (let phaseIdx = 0; phaseIdx < workflow.phases.length; phaseIdx++) {
      const phase = workflow.phases[phaseIdx]!;
      const phaseSteps = run.phases[phaseIdx]!.steps;
      appendTaskOutput(
        task.id,
        `── Phase ${phaseIdx + 1}/${workflow.phases.length}: ${phase.title} ──\n`,
      );

      const outcomes: StepOutcome[] = await Promise.all(
        phaseSteps.map((step) => runStepInRun(task.id, run, step, opts)),
      );
      const skippedCount = outcomes.filter((o) => o.skipped).length;

      appendTaskOutput(
        task.id,
        `  └─ phase ${phaseIdx + 1} ${outcomes.every((o) => o.ok) ? "✓" : "✗"}${
          outcomes.some((o) => !o.ok) ? " (failed steps — later prompts may miss their results)" : ""
        }${skippedCount > 0 ? ` (${skippedCount} skipped)` : ""}\n\n`,
      );
    }

    run.finished = true;
    const failed = workflowRunFailed(run);
    const duration = formatDuration(Date.now() - started);
    appendTaskOutput(task.id, `\n${failed ? "✗ Workflow finished with failures" : "✓ Workflow finished"} — ${allSteps.length} steps · ${duration}\n`);

    updateTaskState(
      task.id,
      failed
        ? { status: "error", endedAt: Date.now(), error: "One or more workflow steps failed." }
        : { status: "done", endedAt: Date.now(), exitCode: 0 },
    );
    opts.onSystemMessage?.(
      `${failed ? "✗" : "✓"} Workflow "${workflow.name}" ${failed ? "finished with failures" : `finished (${allSteps.length} steps · ${duration})`} — full run log: /tasks.`,
    );
  })();

  return task.id;
}
