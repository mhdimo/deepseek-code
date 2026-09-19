/**
 * A refusal nobody can see is a refusal nobody can act on.
 *
 * The execute wrapper refuses a call in five places — the safety floor, the
 * capability floor, a deny rule, plan mode, and the user answering no — and in
 * every one of them the *model* is told, because the refusal becomes the tool
 * result. The operator often is not: an interactive run shows it on screen, but
 * a `--print` run reports itself by exit code and stdout, so a job whose writes
 * were all denied looks exactly like one that made them.
 *
 * `onPermissionDenied` is the channel for that. These tests drive the real
 * wrapper (as `tools.capability.test.ts` does) and pin both halves: every
 * refusal reports, and an approved call does not — a signal that fires on
 * success is noise, and noise is what makes people stop reading it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { toolsToBindingFormat } from "./tools.js";
import { FileWriteTool } from "./tools/FileWriteTool/FileWriteTool.js";
import { createReadState } from "./services/readState.js";
import type { ToolUseContext } from "./Tool.js";
import type { PermissionRuleset } from "./types/index.js";

const FULL: PermissionRuleset = {
  allowRead: true,
  allowWrite: true,
  allowExecute: true,
  allowNetwork: false,
};

const READ_ONLY: PermissionRuleset = { ...FULL, allowWrite: false, allowExecute: false };

const sandboxRoot = mkdtempSync(join(tmpdir(), "perm-denied-"));
let dirCount = 0;

/** A fresh data dir holding `settings.json`, so each test's rules are its own.
 *  Path is part of the settings cache key — no mtime collisions between tests. */
function dataDirWith(settings: Record<string, unknown>): void {
  const dir = join(sandboxRoot, `d${dirCount++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ schemaVersion: 2, ...settings }, null, 2),
  );
  process.env.DEEPSEEK_CODE_DATA_DIR = dir;
}

interface Denial {
  tool: string;
  reason: string;
}

function contextFor(opts: {
  permissions?: PermissionRuleset;
  planMode?: boolean;
  approve?: boolean;
  feedback?: string;
}): { context: ToolUseContext; denials: Denial[] } {
  const denials: Denial[] = [];
  const context = {
    workingDir: sandboxRoot,
    permissions: opts.permissions ?? FULL,
    abortController: new AbortController(),
    requestPermission: async () => ({
      approved: opts.approve ?? true,
      ...(opts.feedback ? { feedback: opts.feedback } : {}),
    }),
    getPlanMode: () => opts.planMode ?? false,
    onToolActivity: () => {},
    onPermissionDenied: (tool: string, reason: string) => denials.push({ tool, reason }),
    readFileState: createReadState(),
  } as unknown as ToolUseContext;
  return { context, denials };
}

/** Drive the real execute wrapper — the layer that refuses. */
async function executeThrough(
  tool: Parameters<typeof toolsToBindingFormat>[0][number],
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<string> {
  const def = toolsToBindingFormat([tool], context).find((d) => d.name === tool.name);
  if (!def) throw new Error(`no binding for ${tool.name}`);
  return String(await def.execute(input));
}

/** A path inside the sandbox that does not exist yet, so the read-before-edit
 *  guard has nothing to say and the refusal can only be the floor under test. */
let pathCount = 0;
function freshPath(): string {
  return join(sandboxRoot, `w${dirCount}-${pathCount++}.txt`);
}

afterAll(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("every refusal reports, with the reason", () => {
  test("a deny rule", async () => {
    dataDirWith({ permissions: { deny: ["Write"] } });
    const { context, denials } = contextFor({});

    await executeThrough(FileWriteTool, { file_path: freshPath(), content: "x" }, context);

    expect(denials.length).toBe(1);
    expect(denials[0]!.tool).toBe("Write");
    expect(denials[0]!.reason).toContain("permissions.deny");
  });

  test("the capability floor", async () => {
    dataDirWith({});
    const { context, denials } = contextFor({ permissions: READ_ONLY });

    await executeThrough(FileWriteTool, { file_path: freshPath(), content: "x" }, context);

    expect(denials.length).toBe(1);
    expect(denials[0]!.tool).toBe("Write");
    expect(denials[0]!.reason).toContain("capability");
  });

  test("plan mode", async () => {
    dataDirWith({});
    const { context, denials } = contextFor({ planMode: true });

    await executeThrough(FileWriteTool, { file_path: freshPath(), content: "x" }, context);

    expect(denials.length).toBe(1);
    expect(denials[0]!.reason).toContain("plan mode");
  });

  test("the user answering no, and what they said", async () => {
    dataDirWith({});
    const { context, denials } = contextFor({ approve: false, feedback: "not that file" });

    await executeThrough(FileWriteTool, { file_path: freshPath(), content: "x" }, context);

    expect(denials.length).toBe(1);
    expect(denials[0]!.tool).toBe("Write");
    expect(denials[0]!.reason).toBe("not that file");
  });

  test("a prompt that says no without a reason still says something", async () => {
    dataDirWith({});
    const { context, denials } = contextFor({ approve: false });

    await executeThrough(FileWriteTool, { file_path: freshPath(), content: "x" }, context);

    expect(denials.length).toBe(1);
    expect(denials[0]!.reason.length).toBeGreaterThan(0);
  });
});

describe("an approved call reports nothing", () => {
  test("running the tool is not a denial", async () => {
    dataDirWith({});
    const { context, denials } = contextFor({});
    const target = freshPath();

    await executeThrough(FileWriteTool, { file_path: target, content: "written" }, context);

    // The write really happened — otherwise this test would pass on a tool
    // that failed for some other reason and reported nothing either.
    expect(await Bun.file(target).text()).toBe("written");
    expect(denials).toEqual([]);
  });

  test("a context that provides no channel is not an error", async () => {
    // Every caller but `--print` omits it, and the wrapper must not care.
    dataDirWith({ permissions: { deny: ["Write"] } });
    const { context } = contextFor({});
    delete (context as { onPermissionDenied?: unknown }).onPermissionDenied;

    const result = await executeThrough(
      FileWriteTool,
      { file_path: freshPath(), content: "x" },
      context,
    );

    expect(result).toContain("Permission denied");
  });
});
