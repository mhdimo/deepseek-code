/**
 * H-2 — an agent's capabilities belong to the agent, not to the rule engine.
 *
 * The rule engine is the user's, and the execute wrapper consults it *before*
 * the tool's own check. That order is right for approving a Write the user has
 * allowlisted, and wrong for *granting* one: `permissions.allow: ["Write"]` in
 * settings.json is a rule about a tool, and it used to short-circuit the
 * per-tool capability guard entirely — so the plan agent, configured read-only
 * precisely so that "look, don't touch" is trustworthy, could write files and
 * run commands. The pool had the same hole from the other side: getTools()
 * ignored its argument, so a read-only agent was *offered* every tool and only
 * failed later, burning a step on each denial.
 *
 * Capability is now decided in one place — the tool's declared
 * `requiredPermission`, enforced in the execute wrapper ahead of every rule —
 * and the pool is filtered by that same field.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getTools, toolsToBindingFormat } from "./tools.js";
import { configFromDiscovered, listDiscoveredAgents } from "./services/agents/agentDiscovery.js";
import { AgentTool } from "./tools/AgentTool/AgentTool.js";
import { FileWriteTool } from "./tools/FileWriteTool/FileWriteTool.js";
import { createReadState, recordKnownState } from "./services/readState.js";
import type { ToolUseContext } from "./Tool.js";
import type { PermissionRuleset } from "./types/index.js";

const READ_ONLY: PermissionRuleset = {
  allowRead: true,
  allowWrite: false,
  allowExecute: false,
  allowNetwork: false,
};

const FULL: PermissionRuleset = {
  allowRead: true,
  allowWrite: true,
  allowExecute: true,
  allowNetwork: false,
};

const sandboxRoot = mkdtempSync(join(tmpdir(), "capability-"));
let dirCount = 0;

/**
 * A fresh data dir holding `settings.json`. Path is part of the settings cache
 * key, so each test gets its own — no mtime collisions, no stale answers.
 * `schemaVersion: 2` keeps the migration chain from rewriting the file.
 */
function dataDirWith(settings: Record<string, unknown>): string {
  const dir = join(sandboxRoot, `d${dirCount++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ schemaVersion: 2, ...settings }, null, 2),
  );
  process.env.DEEPSEEK_CODE_DATA_DIR = dir;
  return dir;
}

function contextFor(
  permissions: PermissionRuleset,
  workingDir: string,
  requestPermission: () => Promise<{ approved: boolean; feedback?: string }> = async () => ({
    approved: true,
  }),
): ToolUseContext {
  return {
    workingDir,
    permissions,
    abortController: new AbortController(),
    requestPermission,
    getPlanMode: () => false,
    onToolActivity: () => {},
    // The read-before-edit guard lives in this same wrapper, one slot ahead of
    // the prompt (services/readState). A context with an empty registry is
    // what a session that has read nothing looks like; the tests that write to
    // an existing file record it first, the way a real Read would.
    readFileState: createReadState(),
  } as unknown as ToolUseContext;
}

/** The pairs of tests below share one settings rule and one refusing prompt
 *  and differ only in the agent's grants — so the refusal can only be the
 *  capability floor, and the write landing can only be the allow rule skipping
 *  the prompt. */
const refuseEverything = async () => ({
  approved: false,
  feedback: "refused by the prompt",
});

/** Drive the real execute wrapper — the layer that consults rules. */
async function executeThrough(
  tool: Parameters<typeof toolsToBindingFormat>[0][number],
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<string> {
  const def = toolsToBindingFormat([tool], context).find((d) => d.name === tool.name);
  if (!def) throw new Error(`no binding for ${tool.name}`);
  return String(await def.execute(input));
}

afterAll(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("the tool pool follows the agent's grants", () => {
  test("a read-only agent is not offered write or execute tools", () => {
    const names = getTools(READ_ONLY).map((t) => t.name);

    expect(names).not.toContain("Write");
    expect(names).not.toContain("Edit");
    expect(names).not.toContain("Bash");
    expect(names).not.toContain("PowerShell");
    expect(names).not.toContain("REPL");
    // …and the read-only tools it is supposed to have are all still there.
    expect(names).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "LS"]));
  });

  test("a full-access agent gets them", () => {
    const names = getTools(FULL).map((t) => t.name);

    expect(names).toEqual(
      expect.arrayContaining(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]),
    );
  });

  test("every tool in a read-only pool declares a read capability", () => {
    for (const tool of getTools(READ_ONLY)) {
      expect(tool.requiredPermission).toBe("allowRead");
    }
  });

  test("an agent definition's tool list narrows the pool further", () => {
    const names = getTools(READ_ONLY, ["Read", "Grep"]).map((t) => t.name);

    expect(names.sort()).toEqual(["Grep", "Read"]);
  });

  test("grants beat the name list: a read-only agent cannot name its way to Write", () => {
    const names = getTools(READ_ONLY, ["Read", "Write"]).map((t) => t.name);

    expect(names).toEqual(["Read"]);
  });
});

describe("a .claude/agents definition gets the tools it asked for", () => {
  /** Write a project-scoped agent definition and resolve it the way the
   *  Agent tool does: frontmatter → definition → config → pool. */
  function resolveFromProject(
    fileName: string,
    frontmatter: string,
  ): {
    allowedTools?: readonly string[];
    permissions: PermissionRuleset;
  } {
    const project = join(sandboxRoot, `proj-${dirCount++}`);
    mkdirSync(join(project, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(project, ".claude", "agents", fileName),
      `---\n${frontmatter}\n---\n\nDo the thing.\n`,
    );

    const def = listDiscoveredAgents(project).find(
      (d) => d.name === fileName.replace(/\.md$/, ""),
    );
    if (!def) throw new Error(`agent ${fileName} did not resolve`);
    const config = configFromDiscovered(def);
    return { allowedTools: config.allowedTools, permissions: config.permissions };
  }

  test("a listed tool set is honoured, not just guessed at from its capabilities", () => {
    const config = resolveFromProject(
      "capability-probe-a.md",
      "name: capability-probe-a\ndescription: reads only\ntools: Read, Grep",
    );

    expect(config.allowedTools).toEqual(["Read", "Grep"]);
    expect(config.permissions.allowWrite).toBe(false);
    expect(getTools(config.permissions, config.allowedTools).map((t) => t.name).sort()).toEqual([
      "Grep",
      "Read",
    ]);
  });

  test("a definition that lists write and execute tools gets them", () => {
    const config = resolveFromProject(
      "capability-probe-b.md",
      "name: capability-probe-b\ndescription: does everything\ntools: [Read, Write, Bash]",
    );

    expect(config.permissions.allowWrite).toBe(true);
    expect(config.permissions.allowExecute).toBe(true);
    expect(getTools(config.permissions, config.allowedTools).map((t) => t.name).sort()).toEqual([
      "Bash",
      "Read",
      "Write",
    ]);
  });

  test("omitting the tool list means no name filter, as before", () => {
    const config = resolveFromProject(
      "capability-probe-c.md",
      "name: capability-probe-c\ndescription: unspecified tools",
    );

    expect(config.allowedTools).toBeUndefined();
    expect(getTools(config.permissions, config.allowedTools).map((t) => t.name)).toContain("Glob");
  });
});

describe("an allow rule cannot grant a capability the agent lacks", () => {
  test("Write is refused for a read-only agent even when settings allow it", async () => {
    const dir = dataDirWith({ permissions: { allow: ["Write"] } });
    const target = join(dir, "victim.txt");
    writeFileSync(target, "original");

    const result = await executeThrough(
      FileWriteTool,
      { file_path: target, content: "rewritten by a read-only agent" },
      contextFor(READ_ONLY, dir, refuseEverything),
    );

    expect(result).toContain("Permission denied");
    expect(result).toContain("allowWrite");
    expect(readFileSync(target, "utf-8")).toBe("original");
  });

  test("the same call, same rule, same refusing prompt, lands with the grant", async () => {
    // Identical to the test above except for the agent's grants. The prompt
    // refuses in both, so the write landing here is the allow rule skipping
    // it — which is what makes the refusal above a capability floor rather
    // than an artifact of rules that never reached the wrapper.
    const dir = dataDirWith({ permissions: { allow: ["Write"] } });
    const target = join(dir, "allowed.txt");
    writeFileSync(target, "original");

    const context = contextFor(FULL, dir, refuseEverything);
    await recordKnownState(context.readFileState, target, "original");

    const result = await executeThrough(
      FileWriteTool,
      { file_path: target, content: "written by a full-access agent" },
      context,
    );

    expect(result).not.toContain("Permission denied");
    expect(readFileSync(target, "utf-8")).toBe("written by a full-access agent");
  });
});

describe("a sub-agent cannot be given more access than its parent", () => {
  test("a read-only agent cannot spawn the full-access agent", async () => {
    const dir = dataDirWith({});

    const result = await executeThrough(
      AgentTool,
      { prompt: "write and run whatever you like", subagent_type: "code" },
      contextFor(READ_ONLY, dir),
    );

    expect(result).toContain("Permission denied");
    expect(result).toContain("cannot be given more access");
  });

  test("a read-only agent may spawn a read-only sub-agent", () => {
    const decision = AgentTool.checkCapability?.(
      { prompt: "explore the repository", subagent_type: "explore" },
      contextFor(READ_ONLY, sandboxRoot),
    );

    expect(decision ?? null).toBeNull();
  });

  test("a full-access agent may spawn the full-access agent", () => {
    const decision = AgentTool.checkCapability?.(
      { prompt: "implement the change", subagent_type: "code" },
      contextFor(FULL, sandboxRoot),
    );

    expect(decision ?? null).toBeNull();
  });
});
