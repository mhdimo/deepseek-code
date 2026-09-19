/**
 * Wiring test: reads and searches outside the working directory reach the
 * permission prompt, and what the prompt answers is what happens.
 *
 * `checkReadAccess` is unit-tested on its own; what this suite pins is that the
 * real tool wrapper actually consults it — the repo's recurring defect is work
 * that is implemented and never called, and a prompt that nothing reaches
 * protects nothing. Both halves are here: the same call is approved in one test
 * and refused in another, so neither the "it ran anyway" nor the "it asked but
 * ignored the answer" failure can pass.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { toolsToBindingFormat } from "../../src/tools.js";
import { FileReadTool } from "../../src/tools/FileReadTool/FileReadTool.js";
import { GlobTool } from "../../src/tools/GlobTool/GlobTool.js";
import { GrepTool } from "../../src/tools/GrepTool/GrepTool.js";
import { createReadState } from "../../src/services/readState.js";
import type { Tool, ToolUseContext } from "../../src/Tool.js";

const sandbox = mkdtempSync(join(tmpdir(), "readwiring-"));
const project = join(sandbox, "project");
mkdirSync(project, { recursive: true });
const inside = join(project, "inside.txt");
const outside = join(sandbox, "outside.txt");
writeFileSync(inside, "INSIDE-CONTENT");
writeFileSync(outside, "OUTSIDE-CONTENT");

let n = 0;

beforeEach(() => {
  // A settings dir of its own per test: a rule on the machine running the
  // suite must not be able to decide these outcomes.
  const dir = join(sandbox, `d${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ schemaVersion: 2 }, null, 2));
  process.env.DEEPSEEK_CODE_DATA_DIR = dir;
});

afterAll(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(sandbox, { recursive: true, force: true });
});

/** The prompts the wrapper raised, in order. */
let asked: Array<{ toolName: string; description: string; input?: unknown }> = [];

function context(approve: boolean | (() => boolean)): ToolUseContext {
  const answer = () => (typeof approve === "function" ? approve() : approve);
  return {
    workingDir: project,
    permissions: { allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: false },
    abortController: new AbortController(),
    readFileState: createReadState(),
    getPlanMode: () => false,
    onToolActivity: () => {},
    requestPermission: async (
      toolName: string,
      description: string | (() => string),
      input?: unknown,
    ) => {
      asked.push({
        toolName,
        description: typeof description === "function" ? description() : description,
        input,
      });
      return answer() ? { approved: true } : { approved: false, feedback: "refused by the user" };
    },
  } as unknown as ToolUseContext;
}

/** Drive the real execute wrapper — the layer that consults the guard. */
async function run(
  ctx: ToolUseContext,
  tool: Tool,
  input: Record<string, unknown>,
): Promise<string> {
  const def = toolsToBindingFormat([tool], ctx).find((d) => d.name === tool.name)!;
  return String(await def.execute(input));
}

beforeEach(() => {
  asked = [];
});

describe("reads outside the working directory", () => {
  test("are refused when the user refuses, and the file is never read", async () => {
    const out = await run(context(false), FileReadTool, { file_path: outside });
    expect(out).toContain("Permission denied");
    expect(out).toContain("refused by the user");
    // The content is the proof it did not run: a denial that still read the
    // file is the defect this suite exists to catch.
    expect(out).not.toContain("OUTSIDE-CONTENT");
    expect(asked).toHaveLength(1);
    // The name the tool asks under is its registered name — the one settings
    // rules are written against (`Read(/etc/**)`), and the one the read dialog
    // has to dispatch on to be reachable at all.
    expect(asked[0]!.toolName).toBe(FileReadTool.name);
    expect(asked[0]!.input).toEqual({ file_path: outside });
  });

  test("run when the user approves — the answer is what decides", async () => {
    const out = await run(context(true), FileReadTool, { file_path: outside });
    expect(asked).toHaveLength(1);
    expect(out).toContain("OUTSIDE-CONTENT");
  });
});

describe("reads inside the working directory", () => {
  test("never ask, and still read the file", async () => {
    const out = await run(context(false), FileReadTool, { file_path: "inside.txt" });
    expect(asked).toHaveLength(0);
    expect(out).toContain("INSIDE-CONTENT");
  });
});

describe("searches outside the working directory", () => {
  test("Glob asks before walking out of the project", async () => {
    const out = await run(context(false), GlobTool, { pattern: "**/*.txt", path: sandbox });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.toolName).toBe(GlobTool.name);
    expect(out).toContain("Permission denied");
  });

  test("Grep asks before searching out of the project", async () => {
    const out = await run(context(false), GrepTool, { pattern: "CONTENT", path: sandbox });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.toolName).toBe(GrepTool.name);
    expect(out).toContain("Permission denied");
  });
});
