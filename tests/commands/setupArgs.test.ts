import { expect, test } from "bun:test";

import { parseSetupArguments, parseSlashCommand } from "../../src/services/commands/commandRegistry";

test("parses the setup key before the optional model", () => {
  const parsed = parseSlashCommand("/setup sk-test-key deepseek-reasoner");
  expect(parsed).not.toBeNull();
  expect(parseSetupArguments(parsed!)).toEqual({
    apiKey: "sk-test-key",
    model: "deepseek-reasoner",
  });
});

test("does not treat bare setup as a credential", () => {
  const parsed = parseSlashCommand("/setup");
  expect(parseSetupArguments(parsed)).toBeNull();
});
