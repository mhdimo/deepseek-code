/**
 * Skills as slash commands.
 *
 * A skill was reachable only through `/skills <name>`, which is a browser, not
 * an invocation: the picker never listed `/code-review`, and typing it fell
 * through every branch of the dispatcher and did nothing at all — no message, no
 * error. Claude Code's whole skill surface is `/name`, so this is the shape
 * users arrive with.
 *
 * The project skill is discovered for real, from a temp cwd — the discovery is
 * cwd-relative by design, and a test that stubbed it would not tell us whether
 * a skill on disk actually becomes a command.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterCommandDefinitions } from "../services/commands/commandRegistry.js";
import {
  clearSkillsCache,
  getSkill,
  listSkills,
  renderSkillPrompt,
  toSkillCommand,
} from "./skillService.js";

const SKILL_BODY = [
  "---",
  "name: ship-it",
  "description: Cut a release from the staged diff",
  "---",
  "",
  "Ship $ARGUMENTS with the repo's own release script.",
].join("\n");

let root: string;
let previousCwd: string;

beforeAll(() => {
  previousCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "dsc-skill-cmd-"));
  const dir = join(root, ".claude", "skills", "ship-it");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), SKILL_BODY);
  process.chdir(root);
  clearSkillsCache();
});

afterAll(() => {
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
  clearSkillsCache();
});

describe("a SKILL.md on disk", () => {
  test("is discovered and invocable by name", () => {
    expect(listSkills().map((s) => s.name)).toContain("ship-it");
    expect(getSkill("ship-it")?.description).toBe("Cut a release from the staged diff");
    // …and by the name as typed at the prompt, slash and all.
    expect(getSkill("/ship-it")?.name).toBe("ship-it");
    expect(getSkill("SHIP-IT")?.name).toBe("ship-it");
  });

  test("becomes a slash command in the picker", () => {
    const commands = filterCommandDefinitions("/ship", listSkills().map(toSkillCommand));
    const match = commands.find((c) => c.name === "ship-it");
    expect(match).toBeDefined();
    expect(match!.category).toBe("skill");
    expect(match!.description).toBe("Cut a release from the staged diff");
    expect(match!.acceptsArgs).toBe(true);
  });

  test("loses to a built-in of the same name", () => {
    // A skill called `review` must not shadow /review, which is a real command
    // with a real handler — the picker drops the duplicate, and the dispatcher
    // never reaches the skill branch for a built-in name.
    const shadow = { ...listSkills()[0]!, name: "review" };
    const commands = filterCommandDefinitions("/review", [toSkillCommand(shadow)]);
    expect(commands.filter((c) => c.name === "review")).toHaveLength(1);
    expect(commands.find((c) => c.name === "review")!.category).not.toBe("skill");
  });
});

describe("renderSkillPrompt", () => {
  const skill = () => getSkill("ship-it")!;

  test("substitutes $ARGUMENTS where the skill asks for them", () => {
    const prompt = renderSkillPrompt(skill(), ["1.2.0", "--dry-run"]);
    expect(prompt).toBe("Ship 1.2.0 --dry-run with the repo's own release script.");
    expect(prompt).not.toContain("$ARGUMENTS");
  });

  test("appends the arguments when the skill never mentions them", () => {
    // Silently dropping the request would look exactly like the skill refusing
    // to do it, which is the worst possible failure for an invocation.
    const plain = { ...skill(), content: "Do the thing." };
    expect(renderSkillPrompt(plain, ["carefully"])).toBe(
      "Do the thing.\n\nUser request/argument: carefully",
    );
    // With no arguments there is nothing to append.
    expect(renderSkillPrompt(plain, [])).toBe("Do the thing.");
  });

  test("positional placeholders fill in too, as custom commands do", () => {
    const positional = { ...skill(), content: "Tag $1 then push to $2." };
    expect(renderSkillPrompt(positional, ["v1", "origin"])).toBe("Tag v1 then push to origin.");
  });
});

describe("the app wires skills into the dispatcher", () => {
  const app = readFileSync(join(import.meta.dir, "../components/App.tsx"), "utf-8");

  test("they are registered when the command list is built", () => {
    // Twice, and both matter: once when the app's command list is assembled,
    // and once after a plugin install/enable/disable, which is what invalidates
    // the skill cache. Counting rather than containing, because either site
    // alone would satisfy a `toContain`.
    const registrations = app.split("setSkillCommands(listSkills().map(toSkillCommand))").length - 1;
    expect(registrations).toBe(2);
    expect(app).toContain("...skillCommands,");
  });

  test("and an unmatched slash command resolves to a skill before failing", () => {
    // The dispatcher's last branch: workflow → custom → skill → plugin. If the
    // skill lookup is not there, `/ship-it` silently does nothing.
    const branch = app.indexOf("const skill = getSkill(command);");
    expect(branch).toBeGreaterThan(0);
    expect(app.slice(branch, branch + 220)).toContain("renderSkillPrompt(skill, restArgs)");
    expect(branch).toBeLessThan(app.indexOf("const pluginCommandName = command;"));
  });
});
