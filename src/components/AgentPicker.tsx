
import React from "react";
import { Dialog } from "../ui/design-system/Dialog.js";
import { Select } from "../ui/design-system/Select.js";
import { agentColorToThemeToken } from "../services/agents/agentColorManager.js";

export interface AgentPickerAgent {
  name: string;
  displayName: string;
  description: string;
  maxSteps?: number;
  permissions: { allowWrite: boolean; allowExecute: boolean };
  /** Teammate color name (rendered as a ● dot) when assigned via /teams. */
  color?: string;
}

export interface AgentPickerProps {
  agents: AgentPickerAgent[];
  currentAgent: string;
  onSelect: (name: string) => void;
  onCancel: () => void;
}

function accessSummary(agent: AgentPickerAgent): string {
  if (agent.permissions.allowWrite && agent.permissions.allowExecute) return "read + write + execute";
  return "read-only";
}

/**
 * Interactive /agent picker over the built-in agents plus discovered custom
 * agents (.claude/agents/*.md), with access level and step budget shown as
 * descriptions (Claude Code AgentsMenu equivalent). Agents with a teammate
 * color render a colored dot.
 */
export default function AgentPicker({
  agents,
  currentAgent,
  onSelect,
  onCancel,
}: AgentPickerProps): React.ReactElement {
  const options = agents.map((agent) => ({
    label: `${agent.displayName} (${agent.name})`,
    value: agent.name,
    description: `${agent.description} · ${accessSummary(agent)}${agent.maxSteps ? ` · max ${agent.maxSteps} steps` : ""}`,
    colorToken: agentColorToThemeToken(agent.color),
  }));

  return (
    <Dialog
      title="Select agent"
      subtitle={`Current: ${currentAgent}`}
      onCancel={onCancel}
      footer={
        `↑↓ to choose · enter to switch · esc to cancel`
      }
    >
      <Select
        options={options}
        defaultValue={currentAgent}
        onChange={onSelect}
        onCancel={onCancel}
        enableNumberKeys
      />
    </Dialog>
  );
}
