/**
 * /agent against Claude Code's AgentsList.
 *
 * The reference heads the list with the source display name (for a list that
 * spans every source, `getAgentSourceDisplayName('all')` is "Agents"), counts
 * the entries in the subtitle and — because the list is navigated by hand —
 * suppresses the dialog's own input guide and prints AgentNavigationFooter
 * beneath it: "Press ↑↓ to navigate · Enter to select · Esc to go back".
 * The port headed the dialog "Select agent", subtitled it with the active
 * agent and footed it with its own three-hint line.
 */
import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";

import AgentPicker, { type AgentPickerAgent } from "../../src/components/AgentPicker.js";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

const AGENTS: AgentPickerAgent[] = [
  {
    name: "code",
    displayName: "Code",
    description: "Full access",
    maxSteps: 25,
    permissions: { allowWrite: true, allowExecute: true },
  },
  {
    name: "plan",
    displayName: "Plan",
    description: "Read-only planning",
    maxSteps: 15,
    permissions: { allowWrite: false, allowExecute: false },
  },
  {
    name: "review",
    displayName: "Review",
    description: "Read-only review",
    maxSteps: 15,
    permissions: { allowWrite: false, allowExecute: false },
  },
];

function frame(columns = 120): string {
  return renderToString(
    React.createElement(AgentPicker, {
      agents: AGENTS,
      currentAgent: "code",
      onSelect: () => {},
      onCancel: () => {},
    }),
    { columns },
  ).replace(ANSI, "");
}

test("the heading is the source display name with an entry count", () => {
  const out = frame();

  expect(out).toContain("Agents");
  expect(out).toContain("3 agents");
  expect(out).not.toContain("Select agent");
  expect(out).not.toContain("Current: code");
});

test("the navigation hint replaces the dialog's own input guide", () => {
  const out = frame();

  expect(out).toContain("Press ↑↓ to navigate · Enter to select · Esc to go back");
  // The port's own guide, with lower-case key names.
  expect(out).not.toContain("↑↓ to choose");
  expect(out).not.toContain("enter to switch");
});
