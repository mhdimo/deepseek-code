/**
 * MCP tools are gated like every other tool — or they are not gated at all.
 *
 * An MCP server's tools arrive as a tool set the engine runs directly, so they
 * bypassed the execute wrapper in `src/tools.ts`: no settings rules, no safety
 * or capability floor, no plan mode, no approval dialog. A server the user had
 * never written a rule for could read files and run commands unsupervised —
 * and `permissions.allow: ["Bash"]` in settings.json, written for the app's
 * Bash tool, was matched against MCP tools by name too.
 *
 * These tests pin the decision order in `createMcpPermissionGate`, which is
 * the whole of the app's answer to that: what is decided without asking, what
 * reaches the prompt, and what may never be lifted by either.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PermissionDecision, type PermissionPolicy } from "ai-sdk-cpp";
import {
  createMcpPermissionGate,
  __builtinToolNames,
  type McpPermissionGate,
} from "./mcpPermissions.js";
import { persistAllowRule } from "../permissions.js";
import { getAllBaseTools } from "../../tools.js";
import type { ToolUseContext, PermissionCallback } from "../../Tool.js";
import type { PermissionRuleset } from "../../types/index.js";

const FULL: PermissionRuleset = {
  allowRead: true,
  allowWrite: true,
  allowExecute: true,
  allowNetwork: true,
};
const READ_ONLY: PermissionRuleset = { ...FULL, allowWrite: false, allowExecute: false };

const sandbox = mkdtempSync(join(tmpdir(), "mcp-perm-"));
let dirCount = 0;

/** A fresh data dir holding `settings.json`, so each test's rules are its own.
 *  Path is part of the settings cache key — no mtime collisions, no stale
 *  answers between tests. `schemaVersion: 2` keeps migrations away. */
function dataDirWith(permissions?: Record<string, unknown>): void {
  const dir = join(sandbox, `d${dirCount++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ schemaVersion: 2, ...(permissions ? { permissions } : {}) }, null, 2),
  );
  process.env.DEEPSEEK_CODE_DATA_DIR = dir;
}

interface Prompt {
  tool: string;
  description: string;
  input?: unknown;
}

/** A context whose prompt is recorded rather than rendered. */
function contextWith(opts: {
  permissions?: PermissionRuleset;
  planMode?: boolean;
  answer?: boolean;
  promptThrows?: boolean;
  onSystemMessage?: (content: string) => void;
}): { context: ToolUseContext; prompts: Prompt[] } {
  const prompts: Prompt[] = [];
  const requestPermission: PermissionCallback = async (tool, description, input) => {
    if (opts.promptThrows) throw new Error("no UI to ask");
    prompts.push({
      tool,
      description: typeof description === "function" ? description() : description,
      input,
    });
    return { approved: opts.answer ?? true };
  };
  const context = {
    workingDir: sandbox,
    permissions: opts.permissions ?? FULL,
    abortController: new AbortController(),
    requestPermission,
    getPlanMode: () => opts.planMode ?? false,
    onSystemMessage: opts.onSystemMessage,
  } as unknown as ToolUseContext;
  return { context, prompts };
}

/**
 * The gate for one server, as `agentSession` builds it: once per session, and
 * handed to the engine for every call the server's tools make. Anything the
 * gate remembers between calls — the "said once already" bookkeeping — only
 * works because of that lifetime, so the tests reuse one gate the same way.
 */
function gateFor(context: ToolUseContext): McpPermissionGate {
  return createMcpPermissionGate(context, "github");
}

/** Run the policy and, when it asks, the approver — the whole gate. */
async function decide(
  gate: McpPermissionGate,
  tool: string,
  input: Record<string, unknown> = {},
): Promise<ReturnType<PermissionPolicy>> {
  const verdict = gate.policy(tool, JSON.stringify(input));
  if (verdict !== PermissionDecision.Ask) return verdict;
  return gate.approver(tool, JSON.stringify(input), "Allow tool to run");
}

afterAll(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("an undecided MCP tool reaches the prompt", () => {
  test("the prompt decides, and its approval runs the tool", async () => {
    dataDirWith();
    const { context, prompts } = contextWith({ answer: true });

    expect(await decide(gateFor(context), "mcp__github__create_issue", { title: "hi" })).toBe(
      PermissionDecision.Allow,
    );
    expect(prompts.length).toBe(1);

    // The user has to be able to tell which server is asking, and what it is
    // about to do with which arguments.
    const [prompt] = prompts;
    expect(prompt?.tool).toBe("mcp__github__create_issue");
    expect(prompt?.description).toContain('"title":"hi"');
    expect(prompt?.description).toContain("github");
    expect(prompt?.input).toEqual({ title: "hi" });
  });

  test("a refusal from the prompt refuses the call", async () => {
    dataDirWith();
    const { context } = contextWith({ answer: false });

    expect(await decide(gateFor(context), "mcp__github__delete_repo", { repo: "x" })).toBe(
      PermissionDecision.Deny,
    );
  });

  test("a prompt that cannot be shown is not an approval", async () => {
    dataDirWith();
    const { context } = contextWith({ promptThrows: true });

    expect(await decide(gateFor(context), "mcp__github__delete_repo", { repo: "x" })).toBe(
      PermissionDecision.Deny,
    );
  });

  test("the name handed to the prompt is the name the engine reports", async () => {
    dataDirWith();
    const { context, prompts } = contextWith({ answer: true });
    await decide(gateFor(context), "mcp__github__create_issue", { title: "hi" });

    // "Yes, and don't ask again" persists an allow rule under this exact name.
    // A display suffix — the dialog knows how to render " (MCP)" — would write
    // a rule that can never match, and the prompt would come back forever.
    persistAllowRule(prompts[0]!.tool);

    const { context: after } = contextWith({ answer: false, promptThrows: true });
    expect(await decide(gateFor(after), "mcp__github__create_issue", { title: "hi" })).toBe(
      PermissionDecision.Allow,
    );
  });
});

describe("rules the user wrote are obeyed without a prompt", () => {
  test("an allow rule matches an MCP tool by name", async () => {
    dataDirWith({ allow: ["mcp__github__create_issue"] });
    const { context, prompts } = contextWith({ promptThrows: true });

    expect(await decide(gateFor(context), "mcp__github__create_issue")).toBe(PermissionDecision.Allow);
    expect(prompts.length).toBe(0);
  });

  test("a deny rule refuses it", async () => {
    dataDirWith({ deny: ["mcp__github__create_issue"] });
    const { context } = contextWith({ promptThrows: true });

    expect(await decide(gateFor(context), "mcp__github__create_issue")).toBe(PermissionDecision.Deny);
  });

  test("a deny rule beats an allow rule, and only where it reaches", async () => {
    // Rule content matches the tool's *input*, not its name — the same
    // language the built-in tools use ("allow reads, except this file").
    dataDirWith({
      allow: ["mcp__fs__read"],
      deny: ["mcp__fs__read(~/.ssh/config)"],
    });
    const { context } = contextWith({ promptThrows: true });

    expect(await decide(gateFor(context), "mcp__fs__read", { file_path: "~/.ssh/config" })).toBe(
      PermissionDecision.Deny,
    );
    // …and the allow rule is not collateral damage from it.
    expect(await decide(gateFor(context), "mcp__fs__read", { file_path: "~/notes.md" })).toBe(
      PermissionDecision.Allow,
    );
  });

  test("an ask rule still cannot lift the floors below it", async () => {
    dataDirWith({ ask: ["mcp__github__read_secret"] });
    const { context, prompts } = contextWith({ answer: true, planMode: true });

    // Plan mode is the floor under test: an `ask` rule means "a human
    // decides", not "skip everything a human would have been protected by".
    expect(await decide(gateFor(context), "mcp__github__read_secret")).toBe(PermissionDecision.Deny);
    expect(prompts.length).toBe(0);
  });
});

// Every test here answers `approved` — so a refusal can only have come from
// the floor under test, never from the prompt. A prompt that throws would
// produce a Deny too, and would hide a floor that had stopped working.
describe("the floors hold with no prompt at all", () => {
  test("a credential path is refused however the input spells it", async () => {
    dataDirWith();
    const { context, prompts } = contextWith({ answer: true });

    const verdict = await decide(gateFor(context), "mcp__fs__read", {
      file_path: "~/.ssh/id_rsa",
    });

    expect(verdict).toBe(PermissionDecision.Deny);
    expect(prompts.length).toBe(0);
  });

  test("a read-only agent is never handed an opaque tool", async () => {
    dataDirWith();
    const { context, prompts } = contextWith({ permissions: READ_ONLY, answer: true });

    expect(await decide(gateFor(context), "mcp__github__create_issue")).toBe(PermissionDecision.Deny);
    expect(prompts.length).toBe(0);
  });

  test("plan mode refuses MCP tools", async () => {
    dataDirWith();
    const { context, prompts } = contextWith({ planMode: true, answer: true });

    expect(await decide(gateFor(context), "mcp__github__create_issue")).toBe(PermissionDecision.Deny);
    expect(prompts.length).toBe(0);
  });

  // An allow rule says "do not ask me about this". It does not say "this call
  // has no floor". The built-in path in src/tools.ts orders it that way — the
  // safety block is checked ahead of the rule — and this gate has to agree
  // with it, or a rule written to stop the prompts quietly becomes a rule that
  // stops the protection.
  describe("an allow rule does not lift them either", () => {
    test("a credential path stays refused under an allow rule", async () => {
      dataDirWith({ allow: ["mcp__fs__read"] });
      const { context, prompts } = contextWith({ answer: true });

      expect(
        await decide(gateFor(context), "mcp__fs__read", { file_path: "~/.ssh/id_rsa" }),
      ).toBe(PermissionDecision.Deny);
      expect(prompts.length).toBe(0);
    });

    test("plan mode stays in force under an allow rule", async () => {
      dataDirWith({ allow: ["mcp__github__create_issue"] });
      const { context, prompts } = contextWith({ planMode: true, answer: true });

      expect(await decide(gateFor(context), "mcp__github__create_issue")).toBe(
        PermissionDecision.Deny,
      );
      expect(prompts.length).toBe(0);
    });

    test("a read-only agent stays read-only under an allow rule", async () => {
      dataDirWith({ allow: ["mcp__github__create_issue"] });
      const { context, prompts } = contextWith({ permissions: READ_ONLY, answer: true });

      expect(await decide(gateFor(context), "mcp__github__create_issue")).toBe(
        PermissionDecision.Deny,
      );
      expect(prompts.length).toBe(0);
    });

    test("and still saves the prompt when no floor applies", async () => {
      // The point of the rule, which the ordering above must not cost: no
      // floor is in play, so the call is allowed without asking.
      dataDirWith({ allow: ["mcp__github__read_issue"] });
      const { context, prompts } = contextWith({ promptThrows: true });

      expect(await decide(gateFor(context), "mcp__github__read_issue")).toBe(
        PermissionDecision.Allow,
      );
      expect(prompts.length).toBe(0);
    });
  });

  test("a tool named after a built-in is refused, loudly and once", async () => {
    dataDirWith();
    const messages: string[] = [];
    const { context, prompts } = contextWith({
      answer: true,
      onSystemMessage: (m) => messages.push(m),
    });

    // A server could name a tool `Bash` and be shown to the user as the app's
    // own Bash tool, which the user has already decided they trust.
    const gate = gateFor(context);
    expect(await decide(gate, "Bash", { command: "rm -rf /" })).toBe(PermissionDecision.Deny);
    expect(await decide(gate, "bash", { command: "rm -rf /" })).toBe(PermissionDecision.Deny);

    expect(prompts.length).toBe(0);
    // Two spellings of one shadow is still one thing worth interrupting for.
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("Bash");
    expect(messages[0]).toContain("github");
  });
});

describe("the built-in name list stays in step with the tool registry", () => {
  test("it covers every tool the app registers", () => {
    // The gate keeps its own list so the permission path never builds the
    // registry (it boots the LSP manager). This is what keeps that safe.
    const missing = getAllBaseTools()
      .map((t) => t.name.toLowerCase())
      .filter((name) => !__builtinToolNames.has(name));

    expect(missing).toEqual([]);
  });
});
