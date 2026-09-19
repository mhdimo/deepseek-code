/**
 * /skills with nothing installed, against Claude Code's SkillsMenu.
 *
 * The reference's empty state is titled "Skills" with the subtitle "No skills
 * found", one line of advice in the body — "Create skills in .claude/skills/ or
 * ~/.claude/skills/" — and an italic "Esc to close" underneath, with the
 * dialog's own input guide suppressed. The port gave the subtitle slot to
 * "SKILL.md instructions the agent can load on demand", used a longer two-line
 * instruction and left "esc to close" in the standard footer position.
 *
 * The skills come from disk, so the only way to reach this branch is to mock
 * the discovery service: the bundled skills always exist in a checkout.
 */
import { expect, mock, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";

mock.module("../../src/skills/skillService.js", () => ({
  listSkills: () => [],
  getSkill: () => null,
  getSkillSourceDir: () => ".claude/skills",
}));

const { default: SkillsMenu } = await import("../../src/components/SkillsMenu.js");

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

const frame = (): string =>
  renderToString(React.createElement(SkillsMenu, { onClose: () => {} }), { columns: 120 }).replace(
    ANSI,
    "",
  );

test("the empty state is subtitled 'No skills found'", () => {
  const out = frame();

  expect(out).toContain("Skills");
  expect(out).toContain("No skills found");
  expect(out).not.toContain("SKILL.md instructions the agent can load on demand");
});

test("the advice is one line, with the close hint in the body", () => {
  const out = frame();

  expect(out).toContain("Create skills in .claude/skills/ or ~/.claude/skills/");
  expect(out).toContain("Esc to close");
  // The port's two-line instruction and its lower-case footer.
  expect(out).not.toContain("No skills available");
  expect(out).not.toContain("esc to close");
});
