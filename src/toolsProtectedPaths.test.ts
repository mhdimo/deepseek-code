/**
 * The reproduction, end to end through the real tool wrapper.
 *
 * The finding was not that a module was missing but that a *rule* was enough:
 * with `permissions.allow: ["Write"]` in settings.json, the wrapper skipped the
 * permission callback entirely, so `Write` reached `.git/hooks/pre-commit` with
 * nothing in the path that could have said no. The prompt below refuses
 * everything, so a write that still lands is a write no one was asked about —
 * which is exactly the assertion these tests make.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getOrCreateMemorySession } from "./services/agent/agentSession.js";
import { toolsToBindingFormat } from "./tools.js";
import { FileEditTool } from "./tools/FileEditTool/FileEditTool.js";
import { FileWriteTool } from "./tools/FileWriteTool/FileWriteTool.js";
import { recordKnownState } from "./services/readState.js";
import type { PermissionCallback } from "./Tool.js";
import type { AgentConfig } from "./types/index.js";

const CODE_AGENT: AgentConfig = {
  name: "code",
  displayName: "Code",
  description: "",
  systemPrompt: "",
  maxSteps: 5,
  permissions: { allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: false },
};

const sandbox = mkdtempSync(join(tmpdir(), "protected-writes-"));
let n = 0;

/** A fresh settings dir per test: the permission cache is keyed by path, so a
 *  shared one would hand a later test the earlier one's rules. */
function dataDirWith(permissions: Record<string, unknown>): void {
  const dir = join(sandbox, `d${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ schemaVersion: 2, permissions }, null, 2),
  );
  process.env.DEEPSEEK_CODE_DATA_DIR = dir;
}

/** The user is not being asked in these tests — but they must still *be* asked
 *  where the guard applies, which is what a refusal proves. */
const refuseEverything: PermissionCallback = async () => ({
  approved: false,
  feedback: "refused by the prompt",
});

const providerConfig = {
  type: "deepseek",
  model: "deepseek-chat",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "test-key",
} as never;

async function writeThrough(memoryDir: string, file: string, content = "x\n") {
  const { context } = await getOrCreateMemorySession({
    providerConfig,
    agentConfig: CODE_AGENT,
    workingDir: sandbox,
    memoryDir: join(sandbox, memoryDir),
    maxContextTokens: 100_000,
    requestPermission: refuseEverything,
  });
  const def = toolsToBindingFormat([FileWriteTool, FileEditTool], context);
  const write = def.find((d) => d.name === "Write")!;
  return String(await write.execute({ file_path: file, content }));
}

afterAll(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("a settings allow rule cannot approve a protected write", () => {
  test("an allowed Write to .git/hooks still reaches the prompt", async () => {
    dataDirWith({ allow: ["Write"] });
    const hooks = join(sandbox, ".git", "hooks", "pre-commit");
    mkdirSync(join(sandbox, ".git", "hooks"), { recursive: true });

    const result = await writeThrough("m-git", hooks, "#!/bin/sh\n");
    expect(result).toContain("Permission denied");
    // The refusal is the point: the file did not change.
    expect(existsSync(hooks)).toBe(false);
  });

  test("the same rule does approve an ordinary file", async () => {
    // The control. Without it, a wrapper that refused everything would pass
    // the test above and tell us nothing.
    dataDirWith({ allow: ["Write"] });
    const ordinary = join(sandbox, "src", "allowed.ts");
    const result = await writeThrough("m-ok", ordinary, "export const a = 1;\n");
    expect(result).toContain("Wrote ");
    expect(existsSync(ordinary)).toBe(true);
  });

  test("a dotfile in the project is protected like the ones in $HOME", async () => {
    dataDirWith({ allow: ["Write"] });
    const rc = join(sandbox, ".zshrc");
    const result = await writeThrough("m-zshrc", rc, "export PATH=$PATH:/evil\n");
    expect(result).toContain("Permission denied");
    expect(existsSync(rc)).toBe(false);
  });

  test("a symlink into .git is the same directory", async () => {
    dataDirWith({ allow: ["Write"] });
    mkdirSync(join(sandbox, ".git", "hooks"), { recursive: true });
    const link = join(sandbox, "harmless-hooks");
    symlinkSync(join(sandbox, ".git", "hooks"), link);

    const result = await writeThrough("m-link", join(link, "pre-commit"), "#!/bin/sh\n");
    expect(result).toContain("Permission denied");
    expect(existsSync(join(sandbox, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  test("an Edit of a protected file is held to the same rule", async () => {
    dataDirWith({ allow: ["Edit"] });
    const settings = join(sandbox, ".claude", "settings.json");
    mkdirSync(join(sandbox, ".claude"), { recursive: true });
    writeFileSync(settings, '{\n  "permissions": {}\n}\n');

    const { context } = await getOrCreateMemorySession({
      providerConfig,
      agentConfig: CODE_AGENT,
      workingDir: sandbox,
      memoryDir: join(sandbox, "m-edit"),
      maxContextTokens: 100_000,
      requestPermission: refuseEverything,
    });
    // The Edit is refused by the protected-path rule, not by the
    // read-before-edit guard that sits one slot ahead of the prompt — so the
    // file has to have been read first, or this would assert the wrong thing.
    await recordKnownState(context.readFileState, settings, '{\n  "permissions": {}\n}\n');
    const edit = toolsToBindingFormat([FileEditTool], context).find((d) => d.name === "Edit")!;
    const result = String(
      await edit.execute({
        file_path: settings,
        old_string: '{}',
        new_string: '{"allow": ["Bash"]}',
      }),
    );
    expect(result).toContain("Permission denied");
    expect(existsSync(settings)).toBe(true);
  });
});
