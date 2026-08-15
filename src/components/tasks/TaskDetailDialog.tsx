import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Dialog } from "../../ui/design-system/Dialog.js";
import { theme, resolveColor } from "../../utils/theme.js";
import {
  killTask,
  listTasks,
  readTaskOutput,
} from "../../services/tasks/backgroundFramework.js";
import { redactSecrets } from "../../utils/redact.js";
import { taskAgentTypeOf, taskDescriptionOf } from "../../utils/taskLabels.js";
import type { TaskState } from "../../Task.js";
import {
  getWorkflowRun,
  retryWorkflowStep,
  skipWorkflowStep,
  type WorkflowRunRecord,
  type WorkflowStepStatus,
} from "../../services/workflow/runner.js";

/**
 * Full-screen detail view for a background task (Claude Code
 * AsyncAgentDetailDialog / ShellDetailDialog equivalent). Agents show their
 * launch prompt, live tool-activity lines, tool/token counts and output tail;
 * shells and workflows show the raw tail. k/x kills a running task,
 * esc/←/q goes back to the list.
 */

export interface TaskDetailDialogProps {
  task: TaskState;
  onBack: () => void;
}

const PROMPT_PREVIEW = 300;
const OUTPUT_LINES = 15;
const ACTIVITY_LINES = 8;

function formatElapsed(task: TaskState): string {
  const end = task.endedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusColor(status: TaskState["status"]): string {
  if (status === "running") return resolveColor(theme.success);
  if (status === "done") return resolveColor(theme.suggestion);
  return resolveColor(theme.error);
}

function statusLabel(status: TaskState["status"]): string {
  if (status === "running") return "Running";
  if (status === "done") return "Completed";
  return "Failed";
}

/** Per-step status glyphs for the workflow detail pane. */
function stepGlyph(status: WorkflowStepStatus): string {
  if (status === "running") return "●";
  if (status === "done") return "✓";
  if (status === "failed") return "✗";
  if (status === "skipped") return "⊘";
  return "·";
}

function stepGlyphColor(status: WorkflowStepStatus): string | undefined {
  if (status === "running") return resolveColor(theme.success);
  if (status === "done") return resolveColor(theme.suggestion);
  if (status === "failed") return resolveColor(theme.error);
  return undefined; // pending/skipped render dim
}

/** Parse the "Done (N tool uses · M tokens · duration)" summary line the
 *  AgentTool appends to an agent task's output. */
function parseDoneLine(output: string): {
  toolUses: number | null;
  tokens: string | null;
} {
  for (const line of output.split("\n")) {
    const m = line.match(/^Done \((\d+) tool uses?(?: · ([\d,]+) tokens)? · ([^)]+)\)$/);
    if (m) return { toolUses: Number(m[1]), tokens: m[2] ?? null };
  }
  return { toolUses: null, tokens: null };
}

export default function TaskDetailDialog({
  task,
  onBack,
}: TaskDetailDialogProps): React.ReactElement {
  // Live view: poll registry state + output tail once a second.
  const [state, setState] = useState<TaskState>(task);
  const [tail, setTail] = useState<string>(() => readTaskOutput(task.id, 16_000)?.output ?? "");
  const [note, setNote] = useState<string | null>(null);
  // Workflow runs expose structured step statuses via the runner; the dialog
  // keeps polling until the user backs out, so a finishing run stays open
  // through completion (the grace period).
  const [wfRun, setWfRun] = useState<WorkflowRunRecord | undefined>(() =>
    task.type === "workflow" ? getWorkflowRun(task.id) : undefined,
  );
  const [stepIndex, setStepIndex] = useState(0);
  const wfSteps = wfRun ? wfRun.phases.flatMap((p) => p.steps) : [];

  useEffect(() => {
    const refresh = () => {
      const live = listTasks().find((t) => t.id === task.id);
      if (live) setState(live);
      setTail(readTaskOutput(task.id, 16_000)?.output ?? "");
      if (task.type === "workflow") setWfRun(getWorkflowRun(task.id));
    };
    refresh();
    const id = setInterval(refresh, 1000);
    return () => clearInterval(id);
  }, [task.id]);

  useInput((input, key) => {
    if (key.escape || key.leftArrow || input === "q") {
      onBack();
      return;
    }
    if ((input === "k" || input === "x") && state.status === "running") {
      const result = killTask(state.id);
      setNote(result.message);
      return;
    }
    // Workflow step control: ↑↓ move the step cursor; `s` skips (pending
    // steps never launch, running agents get aborted), `r` retries the
    // focused step with its original prompt.
    if (wfRun && wfSteps.length > 0) {
      if (key.upArrow) {
        setStepIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setStepIndex((prev) => Math.min(wfSteps.length - 1, prev + 1));
        return;
      }
      const focused = wfSteps[Math.min(stepIndex, wfSteps.length - 1)]!;
      if (input === "s") {
        setNote(skipWorkflowStep(state.id, focused.number).message);
        return;
      }
      if (input === "r") {
        setNote(retryWorkflowStep(state.id, focused.number).message);
        return;
      }
    }
  });

  const isAgent = state.type === "agent";
  const typeLabel = isAgent ? taskAgentTypeOf(state) : state.type;
  const title = `${typeLabel} › ${taskDescriptionOf(state)}`;
  const done = parseDoneLine(tail);
  const activityLines = tail.split("\n").filter((l) => l.startsWith("⎿ "));
  const outputLines = redactSecrets(tail)
    .replace(/\n$/, "")
    .split("\n")
    .slice(-OUTPUT_LINES);

  return (
    <Dialog
      title={title}
      onCancel={onBack}
      footer={
        <Text>
          <Text bold>esc/←</Text> back{state.status === "running" && <> · <Text bold>x</Text> kill</>}
          {state.type === "workflow" && wfRun && (
            <>
              {" "}· <Text bold>↑↓</Text> steps · <Text bold>s</Text> skip · <Text bold>r</Text> retry
            </>
          )}
        </Text>
      }
    >
      <Box flexDirection="column">
        <Box>
          <Text color={statusColor(state.status)}>●</Text>
          <Text>{` ${statusLabel(state.status)} · ${formatElapsed(state)}`}</Text>
          {done.toolUses !== null && (
            <Text dimColor>
              {` · ${done.toolUses} tool use${done.toolUses === 1 ? "" : "s"}`}
              {done.tokens && done.tokens !== "0" ? ` · ${done.tokens} tokens` : ""}
            </Text>
          )}
          {isAgent && done.toolUses === null && state.status === "running" && activityLines.length > 0 && (
            <Text dimColor>{` · ${activityLines.length} tool use${activityLines.length === 1 ? "" : "s"}`}</Text>
          )}
        </Box>

        {isAgent && state.prompt && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor bold>prompt</Text>
            <Text dimColor wrap="truncate-end">
              {state.prompt.length > PROMPT_PREVIEW
                ? `${state.prompt.slice(0, PROMPT_PREVIEW - 1)}…`
                : state.prompt}
            </Text>
          </Box>
        )}

        {isAgent && activityLines.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{`┈ tool activity (last ${ACTIVITY_LINES}, live) ┈`}</Text>
            {activityLines.slice(-ACTIVITY_LINES).map((line, i) => (
              <Text key={i} dimColor wrap="truncate-end">{line}</Text>
            ))}
          </Box>
        )}

        {state.type === "workflow" && wfRun && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{`┈ steps (live) ┈`}</Text>
            {wfRun.phases.map((phase, pi) => (
              <Box key={pi} flexDirection="column">
                <Text dimColor bold>{`Phase ${pi + 1}: ${phase.title}`}</Text>
                {phase.steps.map((step) => {
                  const focused = wfSteps[stepIndex]?.number === step.number;
                  const glyphColor = stepGlyphColor(step.status);
                  return (
                    <Box key={step.number}>
                      <Text color={focused ? resolveColor(theme.claude) : undefined} bold={focused}>
                        {focused ? "❯ " : "  "}
                        <Text color={glyphColor} dimColor={glyphColor === undefined}>
                          {stepGlyph(step.status)}
                        </Text>
                      </Text>
                      <Text color={focused ? resolveColor(theme.claude) : undefined} bold={focused} wrap="truncate-end">
                        {` ${step.stepName} (${step.agentType})`}
                      </Text>
                      {step.status === "running" && <Text dimColor> running…</Text>}
                      {step.status === "done" && step.toolUses !== undefined && (
                        <Text dimColor>{` · ${step.toolUses} tool use${step.toolUses === 1 ? "" : "s"}`}</Text>
                      )}
                      {step.status === "failed" && step.error && (
                        <Text color={resolveColor(theme.error)} wrap="truncate-end">{` — ${step.error}`}</Text>
                      )}
                      {step.retryCount > 0 && <Text dimColor>{` · retry ${step.retryCount}×`}</Text>}
                    </Box>
                  );
                })}
              </Box>
            ))}
          </Box>
        )}

        {/* Shells/workflows show the raw tail; agents already have the
            activity section above (the reference renders it once). */}
        {!isAgent && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{`┈ output (last ${OUTPUT_LINES} lines, live) ┈`}</Text>
            {outputLines.map((line, i) => (
              <Text key={i} dimColor wrap="truncate-end">
                {line === "" ? " " : line}
              </Text>
            ))}
          </Box>
        )}

        {note && (
          <Box marginTop={1}>
            <Text color={resolveColor(theme.warning)}>{note}</Text>
          </Box>
        )}
      </Box>
    </Dialog>
  );
}
