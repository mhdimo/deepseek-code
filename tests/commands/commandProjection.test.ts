import { describe, expect, test } from "bun:test";

import CommandPicker, { ALL_COMMANDS, filterCommands } from "../../src/components/CommandPicker";
import { HELP_GROUPS, allCommandNames } from "../../src/constants/help";
import { toCommandDefs, type CustomCommand } from "../../src/services/customCommands";

describe("shared command projections", () => {
  test("help and picker expose the same supported command names", () => {
    const helpNames = new Set(HELP_GROUPS.flatMap((group) => group.commands.map((command) => command.name)));
    const pickerNames = new Set(ALL_COMMANDS.map((command) => `/${command.name}`));

    expect(helpNames.has("/search")).toBe(true);
    expect(helpNames.has("/export")).toBe(true);
    expect(helpNames.has("/skills")).toBe(true);
    expect(pickerNames).toEqual(helpNames);
    expect(allCommandNames()).toContain("/search");
  });

  test("picker filtering uses the canonical registry", () => {
    expect(filterCommands("/skills")[0]?.name).toBe("skills");
    expect(filterCommands("/export")[0]?.name).toBe("export");
  });

  test("custom commands become canonical definitions", () => {
    const custom: CustomCommand = {
      name: "deploy",
      source: "/tmp/deploy.md",
      description: "Deploy the current project",
      argumentHint: "[environment]",
      body: "deploy $ARGUMENTS",
    };

    expect(toCommandDefs([custom])).toEqual([
      {
        name: "deploy",
        description: "Deploy the current project",
        argumentHint: "[environment]",
        usage: ["/deploy [environment]"],
        category: "custom",
        acceptsArgs: true,
        executionKey: "custom",
      },
    ]);
  });

  test("custom definitions cannot shadow built-ins", () => {
    const reserved: CustomCommand = {
      name: "search",
      source: "/tmp/search.md",
      description: "shadow",
      body: "shadow",
    };

    expect(toCommandDefs([reserved])).toEqual([]);
    expect(CommandPicker).toBeDefined();
  });
});
