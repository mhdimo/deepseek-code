/**
 * The stale-addon case, on its own because it cannot share a process with the
 * rest: the fake SDK below is registered before `agentSession` is imported,
 * and the module namespace is fixed at that point — a flag flipped later would
 * have no effect, and a test that silently kept the new-addon behaviour would
 * be worse than no test.
 *
 * The situation is not hypothetical. The app consumes the SDK through a
 * symlink to a working tree, so the addon and the JS that describes it are
 * built separately, and a stale `.node` is one forgotten `node-gyp rebuild`
 * away. What must not happen then is a gate that answers `Ask` and gets a
 * fail-closed `Deny` back for every call: the user would see an MCP server
 * that connects, lists its tools, and refuses every one of them.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentConfig, ProviderConfig } from "../../types/index.js";

const gated: unknown[] = [];
const attached: unknown[] = [];
const fakeModel = { _native: {}, provider: "deepseek", modelId: "deepseek-chat" };

mock.module("ai-sdk-cpp", () => ({
  PermissionDecision: { Allow: 0, Deny: 1, Ask: 2, AllowAlways: 3 },
  // The whole point: an addon that predates interactive approvals.
  supportsApprover: false,
  createDeepSeek: () => Object.assign(() => fakeModel, { model: () => fakeModel, _native: {} }),
  tool: (name: string) => ({ name }),
  Agent: class {},
  Session: class {},
  mergeToolSets: () => {},
  mcpToolsetFromServer: (configJson: string) => {
    attached.push(JSON.parse(configJson));
    return {};
  },
  withPermissions: (ts: unknown, policy: unknown, approver: unknown) => {
    gated.push({ ts, policy, approver });
    return ts;
  },
}));

const { getOrCreateMemorySession } = await import("./agentSession.js");

const sandbox = mkdtempSync(join(tmpdir(), "mcp-stale-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe("an addon that cannot ask the user", () => {
  test("the server is refused, and the reason names the SDK", async () => {
    const messages: string[] = [];
    await getOrCreateMemorySession({
      providerConfig: {
        type: "deepseek",
        model: "deepseek-chat",
        apiKey: "test-key",
      } as unknown as ProviderConfig,
      agentConfig: {
        name: "code",
        displayName: "Code",
        description: "",
        systemPrompt: "",
        maxSteps: 5,
        permissions: {
          allowRead: true,
          allowWrite: true,
          allowExecute: true,
          allowNetwork: true,
        },
      } as AgentConfig,
      workingDir: sandbox,
      memoryDir: join(sandbox, "m0"),
      mcpServers: { numbers: { command: "bun" } } as never,
      onSystemMessage: (m) => messages.push(m),
    });

    // The server connected — refusing it is a decision, not a failure to
    // connect, and the message has to say which of the two this is.
    expect(attached.length).toBe(1);
    expect(gated.length).toBe(0);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("numbers");
    expect(messages[0]).toContain("ai-sdk-cpp");
  });
});
