/**
 * Step-limit exhaustion, made visible.
 *
 * The native loop is `for (step = 0; step < max_steps; ++step)` and it exits
 * that loop the same way whether the model finished its answer or ran out of
 * budget — the `finish` event carries usage and nothing else. So a truncated
 * run used to look exactly like a completed one: the TUI stopped mid-task with
 * no explanation, and `--print` printed a result and exited 0, which meant CI
 * read a half-finished refactor as success.
 *
 * What the run says on the way is how many calls it made: each one ends in a
 * `finish`, and one whose reason is `tool_calls` is a call that asked for a
 * tool — the loop only gets to spend its next step on one of those. Counting
 * them against the budget is what tells the two apart.
 *
 * `step_finish` would say it outright, and the session path never sends one:
 * the C emitter is wired in `ai_agent_create`, not `ai_session_send_stream`
 * (probed 2026-09-19 against the binding's mock provider — a two-call turn
 * reports two finishes and no step events). Counting it was why a run that
 * spent its whole budget was reported as a clean finish. Both the TUI and
 * `--print` count the call instead.
 *
 * The count is a proxy and is treated as one: reaching the budget means the
 * run *used* its whole budget, which is reported as "possibly incomplete"
 * rather than declared a failure.
 */

/** True when the run consumed its entire step budget. */
export function reachedStepLimit(steps: number, maxSteps: number | undefined): boolean {
  return typeof maxSteps === "number" && maxSteps > 0 && steps >= maxSteps;
}

/** The finish reason a bounded run gets when it ends at its budget. */
export const LIMIT_FINISH_REASON = "max_turns";

/** Headless wording, matching the reference's `Error: Reached max turns (N)`. */
export function stepLimitError(maxSteps: number): string {
  return `Error: Reached max turns (${maxSteps})`;
}

/** TUI wording: what happened, and what to do about it. */
export function stepLimitNotice(maxSteps: number): string {
  return (
    `Reached the step limit (${maxSteps}) — the run stopped mid-task and its last ` +
    `actions may be unfinished. Send another message to continue, or /agent to ` +
    `pick an agent with a larger budget.`
  );
}
