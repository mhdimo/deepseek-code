import { describe, expect, test } from "bun:test";
import { groupSkills } from "./SkillsMenu.js";
import type { SkillInfo, SkillSource } from "../skills/skillService.js";

function makeSkill(name: string, source: SkillSource, extra: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name,
    description: `Description of ${name}`,
    source,
    path: `${source}/${name}/SKILL.md`,
    estimatedTokens: 10,
    ...extra,
  };
}

describe("groupSkills", () => {
  test("groups by source in project > user > bundled > plugin order", () => {
    const groups = groupSkills([
      makeSkill("plugin-skill", "plugin", { pluginName: "My Plugin" }),
      makeSkill("user-skill", "user"),
      makeSkill("bundled-skill", "bundled"),
      makeSkill("project-skill", "project"),
    ]);
    expect(groups.map((g) => g.source)).toEqual(["project", "user", "bundled", "plugin"]);
    expect(groups.map((g) => g.title)).toEqual([
      "Project skills",
      "User skills",
      "Bundled skills",
      "Plugin skills",
    ]);
  });

  test("sorts rows within each group by name", () => {
    const groups = groupSkills([
      makeSkill("zeta", "project"),
      makeSkill("alpha", "project"),
      makeSkill("mid", "project"),
    ]);
    expect(groups[0]!.rows.map((r) => r.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  test("omits sources with no skills", () => {
    const groups = groupSkills([makeSkill("only-user", "user")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.source).toBe("user");
  });

  test("subtitle shows the on-disk directory for file-based sources", () => {
    const groups = groupSkills([
      makeSkill("p", "project"),
      makeSkill("u", "user"),
    ]);
    const project = groups.find((g) => g.source === "project")!;
    const user = groups.find((g) => g.source === "user")!;
    expect(project.subtitle).toBe(".claude/skills");
    expect(user.subtitle).toBe("~/.claude/skills");
  });
});
