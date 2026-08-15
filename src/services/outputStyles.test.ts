import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  listOutputStyles,
  loadCustomOutputStyles,
} from "./outputStyles.js";

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dc-outstyles-"));
  mkdirSync(join(dir, ".claude", "output-styles"), { recursive: true });
  return dir;
}

/** Isolated user root so tests never read the real ~/.claude/output-styles. */
function makeUserDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dc-usertyles-"));
  mkdirSync(join(dir, ".claude", "output-styles"), { recursive: true });
  return dir;
}

describe("loadCustomOutputStyles", () => {
  test("discovers styles with frontmatter name/description and body prompt", async () => {
    const dir = makeProjectDir();
    writeFileSync(
      join(dir, ".claude", "output-styles", "concise.md"),
      ["---", "name: Concise", "description: Short and to the point", "---", "", "Answer briefly."].join(
        "\n",
      ),
    );
    const styles = await loadCustomOutputStyles(dir, makeUserDir());
    expect(styles).toHaveLength(1);
    expect(styles[0]).toMatchObject({
      name: "Concise",
      description: "Short and to the point",
      prompt: "Answer briefly.",
      source: "project",
    });
  });

  test("falls back to filename and first body line", async () => {
    const dir = makeProjectDir();
    writeFileSync(join(dir, ".claude", "output-styles", "terse.md"), "Be terse.\nSecond line.");
    const styles = await loadCustomOutputStyles(dir, makeUserDir());
    expect(styles[0]?.name).toBe("terse");
    expect(styles[0]?.description).toBe("Be terse.");
    expect(styles[0]?.prompt).toBe("Be terse.\nSecond line.");
  });

  test("project styles override user styles by name", async () => {
    const dir = makeProjectDir();
    const userDir = makeUserDir();
    writeFileSync(
      join(userDir, ".claude", "output-styles", "custom.md"),
      "---\nname: Shared\n---\nUser version.",
    );
    writeFileSync(
      join(dir, ".claude", "output-styles", "custom.md"),
      "---\nname: Shared\n---\nProject version.",
    );
    const styles = await loadCustomOutputStyles(dir, userDir);
    expect(styles).toHaveLength(1);
    expect(styles[0]?.prompt).toBe("Project version.");
    expect(styles[0]?.source).toBe("project");
  });

  test("ignores missing dirs and non-markdown files", async () => {
    const dir = makeProjectDir();
    writeFileSync(join(dir, ".claude", "output-styles", "notes.txt"), "not a style");
    const styles = await loadCustomOutputStyles(dir, makeUserDir());
    expect(styles).toEqual([]);
  });

  test("merges discovered styles after the built-ins in listOutputStyles", async () => {
    const dir = makeProjectDir();
    writeFileSync(
      join(dir, ".claude", "output-styles", "zen.md"),
      "---\ndescription: Calm\n---\nZen body.",
    );
    await loadCustomOutputStyles(dir, makeUserDir());
    const names = listOutputStyles().map((s) => s.name.toLowerCase());
    expect(names[0]).toBe(DEFAULT_OUTPUT_STYLE_NAME);
    expect(names).toContain("zen");
    expect(names.indexOf("zen")).toBeGreaterThan(names.indexOf(DEFAULT_OUTPUT_STYLE_NAME));
  });
});
