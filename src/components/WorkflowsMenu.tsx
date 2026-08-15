
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select } from "../ui/design-system/Select.js";
import { listWorkflows, type Workflow } from "../services/workflow/workflowService.js";
import { listTasks } from "../services/tasks/backgroundFramework.js";

export interface WorkflowsMenuProps {
  /** Launch a run (input = args typed after the workflow command). */
  onRun: (workflow: Workflow, input: string) => void;
  onClose: () => void;
}

/**
 * Interactive /workflows manager (Claude Code workflows surface equivalent):
 * list discovered workflows with phase/step summaries and a live count of
 * running workflow tasks. Enter starts a run; pass args via
 * `/workflow-name <args>` instead.
 */
export default function WorkflowsMenu({ onRun, onClose }: WorkflowsMenuProps): React.ReactElement {
  const [workflows] = useState<Workflow[]>(() => listWorkflows());
  const [runningCount, setRunningCount] = useState(0);

  useEffect(() => {
    const update = () =>
      setRunningCount(listTasks().filter((t) => t.type === "workflow" && t.status === "running").length);
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  const options = workflows.map((workflow) => ({
    label: workflow.name,
    value: workflow.name,
    description: `${workflow.description} · ${workflow.phases.length} phase(s), ${workflow.phases.reduce((n, p) => n + p.steps.length, 0)} steps (${workflow.source})`,
  }));

  return (
    <Dialog
      title="Workflows"
      subtitle="Multi-phase subagent orchestrations — runs as a background task, watch it with /tasks"
      onCancel={onClose}
      footer="↑↓ to choose · enter to run (no args) · esc to cancel · pass args via /name <args>"
    >
      {options.length === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>
            No workflows found. Add .md files to .claude/workflows/ (project) or ~/.claude/workflows/ (user).
          </Text>
          <Text dimColor>
            {`Syntax: \`---\` frontmatter (name, description) + \`## Phase: <title>\` sections with \`- agent: code|plan|review · name: … · prompt: …\` steps.`}
          </Text>
        </Box>
      ) : (
        <Select
          options={options}
          onChange={(name) => {
            const workflow = workflows.find((w) => w.name === name);
            if (workflow) onRun(workflow, "");
          }}
          onCancel={onClose}
        />
      )}
      <Text dimColor>
        {runningCount > 0 ? `${runningCount} workflow run(s) in progress — /tasks to watch` : "No workflow runs in progress"}
      </Text>
    </Dialog>
  );
}
