/**
 * The skills list is the app's longest picker — 45 rows in a real install
 * against a six-row window — so it is where hover-scrolling was worst: the
 * pointer lit a row and the window immediately slid to recentre on it, so the
 * highlight never sat under the cursor.
 *
 * The list only scrolls with more discovered skills than the window shows, so
 * this file runs against a throwaway project root of fixture skills. Project
 * skills are found relative to the process cwd, and the directory is restored
 * before the test returns so no other file sees it (HOME would not work here:
 * Bun caches `os.homedir()` at startup, so setting process.env.HOME at
 * runtime is ignored).
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { elementRect } from "../../src/components/mouseRegions.js";
import { move, mountWithMouse, settle } from "./mouseTestHarness.js";

process.env.DEEPSEEK_CODE_DATA_DIR = mkdtempSync(join(tmpdir(), "dsskillsdata-"));

const projectRoot = mkdtempSync(join(tmpdir(), "dsskillsproj-"));
for (let i = 1; i <= 8; i++) {
  const dir = join(projectRoot, ".claude", "skills", `fixture-skill-${i}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: fixture-skill-${i}\ndescription: Fixture skill ${i} for the window test\n---\n\nBody ${i}.\n`,
  );
}

test("hovering the skills list keeps its window under the pointer", async () => {
  const realCwd = process.cwd();
  process.chdir(projectRoot);
  try {
    const { listSkills } = await import("../../src/skills/skillService.js");
    const { default: SkillsMenu, groupSkills } = await import(
      "../../src/components/SkillsMenu.js"
    );
    const rows = groupSkills(listSkills()).flatMap((group) => group.rows);
    expect(rows.length).toBeGreaterThan(6); // the window really does scroll here

    const menu = mountWithMouse(React.createElement(SkillsMenu, { onClose: () => {} }));
    try {
      await settle();
      expect(menu.frame()).toContain(rows[0]!.name); // the window opens at the top
      const mark = menu.frame().length;

      // The last row the six-row window shows — the one a recentre would move.
      const region = [...menu.registry.regions.values()][5]!;
      const rect = elementRect(region.ref.current)!;
      await move(menu, rect.left + 1, rect.top + 1);
      await settle();
      await settle();

      const after = menu.frame().slice(mark);
      expect(after).toContain(rows[0]!.name); // the window stayed where it was …
      expect(after).toContain(`and ${rows.length - 6} more…`); // … and still ends there
    } finally {
      menu.unmount();
    }
  } finally {
    process.chdir(realCwd);
  }
});
