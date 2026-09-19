/**
 * Plan mode has to mean something outside the permission prompt.
 *
 * There are two plan states in this app and only one of them reached the tool
 * wrapper. EnterPlanMode sets state the session owns, and the wrapper denies
 * non-read-only tools ahead of every rule. Shift+Tab sets the UI's permission
 * mode, which was enforced *only* inside App.requestPermission — and the
 * wrapper skips requestPermission entirely when a settings allow rule matched,
 * so `permissions.allow: ["Write"]` made every Write execute while the
 * StatusBar read "plan".
 *
 * The wrapper consults one thing, `context.getPlanMode()`, so both states have
 * to arrive there — including on a session that was built before the mode
 * changed (the cached path), which is the case a naive fix misses.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getOrCreateMemorySession } from "./agentSession.js";
import { toolsToBindingFormat } from "../../tools.js";
import { recordKnownState } from "../../services/readState.js";
import { AgentTool } from "../../tools/AgentTool/AgentTool.js";
import { FileWriteTool } from "../../tools/FileWriteTool/FileWriteTool.js";
import type { PermissionCallback } from "../../Tool.js";
import type { AgentConfig, PermissionRuleset } from "../../types/index.js";

/** The `code` agent's shape, written out here rather than imported: another
 *  test file mocks the agent registry for the whole run, so asking it for a
 *  config would make these assertions depend on file order. */
const CODE_AGENT: AgentConfig = {
  name: "code",
  displayName: "Code",
  description: "",
  systemPrompt: "",
  maxSteps: 5,
  permissions: { allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: false },
};

const sandbox = mkdtempSync(join(tmpdir(), "planmode-"));
let n = 0;

/** Each test gets its own settings dir — the settings cache is keyed by path,
 *  so a shared file would hand a later test the earlier one's rules. */
function dataDirWith(permissions: Record<string, unknown>): void {
  const dir = join(sandbox, `d${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ schemaVersion: 2, permissions }, null, 2),
  );
  process.env.DEEPSEEK_CODE_DATA_DIR = dir;
}

/** A prompt that refuses everything. None of these tests is about the prompt:
 *  it is here so that an allow rule has to be what lets a write through, and
 *  the plan-mode refusal means something. */
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

/** A real session, built the way App builds one. `memoryDir` distinguishes
 *  sessions in the module cache; the same value on purpose exercises the
 *  cached path. */
async function session(opts: {
  memoryDir: string;
  isPlanMode?: () => boolean;
  requestPermission?: PermissionCallback;
}) {
  const { context } = await getOrCreateMemorySession({
    providerConfig,
    agentConfig: CODE_AGENT,
    workingDir: sandbox,
    memoryDir: opts.memoryDir,
    maxContextTokens: 100_000,
    isPlanMode: opts.isPlanMode,
    requestPermission: opts.requestPermission,
  });
  return context;
}

async function writeThrough(
  context: Awaited<ReturnType<typeof session>>,
  file: string,
  content: string,
) {
  const def = toolsToBindingFormat([FileWriteTool], context).find((d) => d.name === "Write")!;
  return String(await def.execute({ file_path: file, content }));
}

/** The Read a real session does before it writes, recorded the way FileReadTool
 *  records it. These tests are about the permission layer, which sits behind
 *  the read-before-edit guard (services/readState) — so they have to look at
 *  the file first, or every assertion below would be about that guard. */
async function readFirst(context: Awaited<ReturnType<typeof session>>, file: string) {
  await recordKnownState(context.readFileState, file, readFileSync(file, "utf-8"));
}

afterAll(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("plan mode reaches the tool wrapper", () => {
  // First in the file on purpose: the session cache is module-level, and the
  // identity assertion below only means something while this entry is the one
  // the cache is holding.
  test("a cached session follows the mode as it changes", async () => {
    const memoryDir = join(sandbox, "m-toggle");
    const first = await session({ memoryDir, isPlanMode: () => false });
    expect(first.getPlanMode()).toBe(false);

    // Same key → the cached session comes back, and it must read the mode from
    // the *new* provider rather than the one it was built with. A fresh
    // function each time, deliberately: a provider over a shared mutable
    // variable would answer correctly even if the refresh were missing.
    const second = await session({ memoryDir, isPlanMode: () => true });
    expect(second).toBe(first);
    expect(second.getPlanMode()).toBe(true);

    const third = await session({ memoryDir, isPlanMode: () => false });
    expect(third.getPlanMode()).toBe(false);
  });

  test("the UI's mode is what the wrapper consults", async () => {
    expect((await session({ memoryDir: join(sandbox, "m-plain") })).getPlanMode()).toBe(false);
    expect(
      (await session({ memoryDir: join(sandbox, "m-plan"), isPlanMode: () => true })).getPlanMode(),
    ).toBe(true);
  });

  // The regression this file exists for. An allow rule short-circuits
  // `checkPermissions` — the first two tests below pin that down, so the third
  // is not asserting something the prompt would have refused anyway.
  test("an allow rule skips the prompt entirely", async () => {
    dataDirWith({ allow: ["Write"] });
    const context = await session({
      memoryDir: join(sandbox, "m-bypass"),
      requestPermission: refuseEverything,
    });
    const target = join(sandbox, "bypassed.txt");
    writeFileSync(target, "original");
    await readFirst(context, target);

    const result = await writeThrough(context, target, "allowed by rule");

    expect(result).not.toContain("Permission denied");
    expect(readFileSync(target, "utf-8")).toBe("allowed by rule");
  });

  test("without a rule the prompt is what refuses", async () => {
    // The control that makes the test above mean something: the refusing
    // prompt is real, so the write landing there proves the rule skipped it.
    dataDirWith({});
    const context = await session({
      memoryDir: join(sandbox, "m-prompt"),
      requestPermission: refuseEverything,
    });
    const target = join(sandbox, "prompted.txt");
    writeFileSync(target, "original");
    await readFirst(context, target);

    const result = await writeThrough(context, target, "refused by the prompt");

    expect(result).toContain("refused by the prompt");
    expect(readFileSync(target, "utf-8")).toBe("original");
  });

  test("in plan mode the same allow rule is not enough", async () => {
    dataDirWith({ allow: ["Write"] });
    const context = await session({
      memoryDir: join(sandbox, "m-deny"),
      isPlanMode: () => true,
      requestPermission: refuseEverything,
    });
    const target = join(sandbox, "planned.txt");
    writeFileSync(target, "original");

    const result = await writeThrough(context, target, "written in plan mode");

    expect(result).toContain("Permission denied");
    expect(result).toContain("plan mode");
    expect(readFileSync(target, "utf-8")).toBe("original");
  });
});

describe("plan mode is not delegatable", () => {
  test("a write-capable sub-agent is refused in plan mode", async () => {
    const context = await session({ memoryDir: join(sandbox, "m-spawn"), isPlanMode: () => true });

    const decision = AgentTool.checkCapability?.(
      { prompt: "implement it", subagent_type: "code" },
      context,
    );

    expect(decision?.approved).toBe(false);
    expect(decision?.feedback).toContain("plan mode");
  });

  test("a read-only sub-agent is still allowed in plan mode", async () => {
    const context = await session({ memoryDir: join(sandbox, "m-spawn2"), isPlanMode: () => true });

    const decision = AgentTool.checkCapability?.(
      { prompt: "explore the repository", subagent_type: "explore" },
      context,
    );

    expect(decision ?? null).toBeNull();
  });
});

describe("the ruleset the session advertises", () => {
  test("is the agent's, unchanged by plan mode", async () => {
    const context = await session({ memoryDir: join(sandbox, "m-grants"), isPlanMode: () => true });
    // Plan mode is a mode, not a demotion of the agent: the grants stay put
    // and the wrapper's gate does the refusing, so leaving plan mode restores
    // the tool pool without rebuilding the session.
    const grants = context.permissions as PermissionRuleset;
    expect(grants.allowWrite).toBe(true);
    expect(grants.allowExecute).toBe(true);
  });
});
