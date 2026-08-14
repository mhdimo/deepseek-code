import { describe, expect, test } from "bun:test";

import {
  BUILTIN_COMMANDS,
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
