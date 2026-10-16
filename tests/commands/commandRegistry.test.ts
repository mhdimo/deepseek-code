import { describe, expect, test } from "bun:test";

import {
  BUILTIN_COMMANDS,
  commandActivationText,
  filterCommandDefinitions,
  mergeCommandDefinitions,
  parseSlashCommand,
  resolveCommandName,
} from "../../src/services/commands/commandRegistry";

describe("canonical slash command registry", () => {
  test("parses a command and preserves its argument tail", () => {
    expect(parseSlashCommand("/model deepseek-reasoner")).toEqual({
      canonicalName: "model",
      args: ["deepseek-reasoner"],
      rawArgs: "deepseek-reasoner",
      input: "/model deepseek-reasoner",
    });
  });

  test("resolves aliases case-insensitively", () => {
    expect(resolveCommandName("/quit")).toBe("exit");
    expect(resolveCommandName("/?")).toBe("help");
    expect(resolveCommandName("/USAGE")).toBe("usage");
  });

  test("/models is the model command, not a second row in the picker", () => {
    // Both names ran the same picker, so the picker listed the same action
    // twice; the plural survives as an alias.
    expect(resolveCommandName("/models")).toBe("model");
    expect(parseSlashCommand("/models deepseek-v4-pro")?.canonicalName).toBe("model");
    // Only the singular is a row — for "/mode" that is the first hit, and no
    // second model-ish command follows it. (setup matches on its description.)
    const matches = filterCommandDefinitions("/mode").map((command) => command.name);
    expect(matches[0]).toBe("model");
    expect(matches.filter((name) => name.startsWith("model"))).toEqual(["model"]);
  });

  test("tokenizes quoted arguments while preserving raw arguments", () => {
    expect(parseSlashCommand('/statusline "git branch --show-current"')).toEqual({
      canonicalName: "statusline",
      args: ["git branch --show-current"],
      rawArgs: '"git branch --show-current"',
      input: '/statusline "git branch --show-current"',
    });
  });

  test("filters commands by canonical name", () => {
    const matches = filterCommandDefinitions("/co");
    expect(matches.slice(0, 3).map((command) => command.name)).toEqual(["commit", "compact", "config"]);
    expect(matches.map((command) => command.name)).toContain("context");
  });

  test("returns the complete built-in list for a bare slash", () => {
    expect(filterCommandDefinitions("/").length).toBe(BUILTIN_COMMANDS.length);
  });

  test("does not activate for empty input or ordinary prompt text", () => {
    expect(filterCommandDefinitions("/").length).toBeGreaterThan(0);
    expect(filterCommandDefinitions("")).toEqual([]);
    expect(filterCommandDefinitions("what could be improved here?")).toEqual([]);
  });

  test("merges definitions by canonical name and keeps the first definition", () => {
    const merged = mergeCommandDefinitions(
      [
        {
          name: "demo",
          description: "first",
          category: "general",
          executionKey: "builtin",
        },
      ],
      [
        {
          name: "demo",
          description: "second",
          category: "custom",
          executionKey: "custom",
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.description).toBe("first");
  });
});

describe("command activation text", () => {
  // The bug this pins: picking /effort with a partial name used to type the
  // usage template — "/effort [off|low|medium|high|max]" — into the prompt, so
  // the user had to delete the hint before the command would run. The
  // reference only ever inserts the NAME and renders the hint as dim
  // placeholder text (BaseTextInput.tsx:92-111); Enter runs the command.
  test("Enter runs the picked command by name, never a usage template", () => {
    expect(commandActivationText({ name: "effort", acceptsArgs: true }, true)).toBe("/effort");
    expect(commandActivationText({ name: "model", acceptsArgs: true }, true)).toBe("/model");
    expect(commandActivationText({ name: "clear" }, true)).toBe("/clear");
  });

  test("Tab completes the name, leaving a space for a command that takes args", () => {
    expect(commandActivationText({ name: "effort", acceptsArgs: true }, false)).toBe("/effort ");
    expect(commandActivationText({ name: "clear" }, false)).toBe("/clear");
  });

  test("no built-in can put its usage hint into the prompt", () => {
    for (const cmd of BUILTIN_COMMANDS) {
      expect(commandActivationText(cmd, true)).toBe(`/${cmd.name}`);
      const completion = commandActivationText(cmd, false);
      expect(completion).not.toMatch(/[\[<]/); // no "[off|low|…]" / "<name>"
    }
  });
});
