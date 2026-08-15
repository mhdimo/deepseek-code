import { expect, test } from "bun:test";

import { BUILTIN_COMMANDS, resolveCommandName } from "../../src/services/commands/commandRegistry";

test("supports the useful local aliases from Claude-style command workflows", () => {
  expect(resolveCommandName("/keybindings")).toBe("shortcuts");
  expect(resolveCommandName("/color")).toBe("theme");
  expect(resolveCommandName("/tasks")).toBe("bashes");
  expect(resolveCommandName("/todos")).toBe("todos");
  expect(resolveCommandName("/login")).toBe("setup");
  expect(BUILTIN_COMMANDS.map((command) => command.name)).toContain("test");
  expect(BUILTIN_COMMANDS.map((command) => command.name)).toContain("files");
  expect(BUILTIN_COMMANDS.map((command) => command.name)).toContain("terminal-setup");
});

test("keeps every declared built-in name unique", () => {
  const names = BUILTIN_COMMANDS.map((command) => command.name);
  expect(new Set(names).size).toBe(names.length);
});
