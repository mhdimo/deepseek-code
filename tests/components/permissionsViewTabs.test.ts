/**
 * What /permissions puts on screen.
 *
 * The screen is a port of Claude Code's PermissionRuleList, and it had drifted
 * into a different shape: one flat "Permission rules" list mixing allow, ask
 * and deny rows, each row two lines tall with a "{section} rule · From
 * settings" description, no tab set, no search box until you typed, the create
 * action hidden behind the "a" key, and a Dialog-framed delete confirmation.
 * Rendering the view is the only way to see any of that — the rule data and
 * the persistence calls are unchanged by the port.
 */
import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import PermissionsView, {
  DeleteRuleCard,
  permissionsGuide,
} from "../../src/components/PermissionsView";

const BASE = {
  userRules: { allow: ["Bash(git status)", "Read(**)"], ask: ["Edit(src/**)"], deny: [] },
  projectRules: { allow: [], ask: [], deny: ["Bash(rm -rf *)"] },
  sessionRules: { allow: ["WebFetch(**)"], deny: [] },
  onPersistRules: () => {},
  onPersistProjectRules: () => {},
  onSessionRulesChange: () => {},
  onSummary: () => {},
  onClose: () => {},
};

function render(over: Partial<typeof BASE> = {}): string {
  return renderToString(React.createElement(PermissionsView, { ...BASE, ...over }));
}

test("the pane is titled 'Permissions:' and carries one tab per behavior", () => {
  const frame = render();
  expect(frame).toContain("Permissions:");
  for (const tab of ["Allow", "Ask", "Deny"]) expect(frame).toContain(tab);
  expect(frame).not.toContain("Permission rules");
});

test("each tab explains itself instead of printing the rule syntax", () => {
  const frame = render();
  expect(frame).toContain("DeepSeek Code won't ask before using allowed tools.");
  expect(frame).not.toContain("Tool(spec:pattern) · deny > ask > allow");
});

test("the active tab shows only its own section's rules", () => {
  const frame = render();
  expect(frame).toContain("Bash(git status)");
  expect(frame).toContain("Read(**)");
  expect(frame).toContain("WebFetch(**)"); // session allow rules belong here too
  expect(frame).not.toContain("Edit(src/**)"); // ask tab
  expect(frame).not.toContain("Bash(rm -rf *)"); // deny tab
});

test("rule rows are a single line each", () => {
  const frame = render();
  expect(frame).not.toContain("allow rule · From settings");
  expect(frame).not.toContain("From settings");
  // The rule text alone, on a line whose only other content is the Select
  // marker's indent and the index cell — the second line of the old row is
  // what is gone. The index is the reference's: its Select leaves
  // `hideIndexes` at its `false` default, and PermissionRuleList does not
  // override it.
  expect(frame).toMatch(/^ {4}\d+\. Bash\(git status\)$/m);
});

test("the create action is the first row, and the search box is always shown", () => {
  const frame = render();
  const add = frame.indexOf("Add a new rule…");
  expect(add).toBeGreaterThan(-1);
  expect(add).toBeLessThan(frame.indexOf("Bash(git status)"));
  // First row of the list, and numbered like every other row.
  expect(frame).toMatch(/^ {2}❯ 1\. Add a new rule…$/m);
  expect(frame).toContain("⌕ Search…");
});

test("with no rules the tabs, the explanation and the create row still render", () => {
  const frame = render({
    userRules: { allow: [], ask: [], deny: [] },
    projectRules: { allow: [], ask: [], deny: [] },
    sessionRules: { allow: [], deny: [] },
  });
  expect(frame).toContain("Permissions:");
  expect(frame).toContain("DeepSeek Code won't ask before using allowed tools.");
  expect(frame).toContain("Add a new rule…");
  expect(frame).not.toContain("No rules configured");
  expect(frame).not.toContain("No rules match the filter");
});

test("the guide line follows the focus", () => {
  expect(permissionsGuide(true, false)).toBe("←/→ tab switch · ↓ return · Esc cancel");
  expect(permissionsGuide(false, true)).toBe(
    "Type to filter · Enter/↓ select · ↑ tabs · Esc clear",
  );
  expect(permissionsGuide(false, false)).toBe(
    "↑↓ navigate · Enter select · Type to search · ←/→ switch · Esc cancel",
  );
  // The pane opens with the tab header focused, so that is the line shown.
  const frame = render();
  expect(frame).toContain("←/→ tab switch · ↓ return · Esc cancel");
  expect(frame).not.toContain("a add");
});

test("the delete confirmation is a rounded card with one cancel hint", () => {
  const frame = renderToString(
    React.createElement(DeleteRuleCard, {
      rule: { id: "user:allow:0", section: "allow", source: "user", text: "Bash(git status)" },
      shadowers: ["Bash(**)"],
      onDelete: () => {},
      onCancel: () => {},
    }),
  );
  expect(frame).toContain("╭");
  expect(frame).toContain("Delete allowed tool?");
  expect(frame).toContain("Are you sure you want to delete this permission rule?");
  expect(frame).toContain("Warning: shadowed by Bash(**)");
  expect(frame).toContain("Esc to cancel");
  expect(frame).not.toContain("↑↓ choose");
});
