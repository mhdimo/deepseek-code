/**
 * How an MCP server reaches the agent — and what happens when it cannot.
 *
 * `mcpPermissions.test.ts` pins the decisions the gate makes. This pins the
 * wiring around it, which is the part that fails silently: a tool set attached
 * without its approver refuses every undecided call (safe, but the server
 * looks broken), and a server whose config is refused is simply *absent* from
 * the agent — the model has no way to find out why, and neither does the user
 * unless we say so.
 *
 * The SDK is faked here on purpose. What needs asserting is what the app hands
 * the engine, not what the engine does with it — and the engine cannot be
 * driven without a model to talk to.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentConfig, ProviderConfig } from "../../types/index.js";

/** What the fake SDK saw. */
const attached: Array<{ config: Record<string, unknown>; ts: unknown }> = [];
const gated: Array<{ ts: unknown; policy: unknown; approver: unknown }> = [];
/** Everything that happened, in order, so "before" can be asserted. */
const log: string[] = [];
/** Make the fake server fail to start. */
let serverThrows: Error | null = null;

const fakeModel = { _native: {}, provider: "deepseek", modelId: "deepseek-chat" };

// The addon here always understands the approver. The other half of the
// contract — an addon that does not — lives in mcpAttach.staleAddon.test.ts,
// because this namespace is snapshotted when it is registered.
mock.module("ai-sdk-cpp", () => ({
  PermissionDecision: { Allow: 0, Deny: 1, Ask: 2, AllowAlways: 3 },
  supportsApprover: true,
  createDeepSeek: () =>
    Object.assign(() => fakeModel, { model: () => fakeModel, _native: {} }),
  tool: (name: string, _schema: unknown, description: string, execute: unknown) => ({
    name,
    description,
    execute,
  }),
  Agent: class {
    constructor() {}
  },
  Session: class {
    constructor() {}
  },
  mergeToolSets: () => {},
  mcpToolsetFromServer: (configJson: string) => {
    const config = JSON.parse(configJson) as Record<string, unknown>;
    // The engine's contract: a server that will not start throws, and the
    // message is the user's only account of why.
    if (serverThrows) throw serverThrows;
    if (String(config.command).startsWith("nope")) {
      throw new Error(`MCP: failed to spawn server process '${config.command}'`);
    }
    const ts = { server: config.name };
    log.push(`connect:${String(config.name)}`);
    attached.push({ config, ts });
    return ts;
  },
  withPermissions: (ts: unknown, policy: unknown, approver: unknown) => {
    gated.push({ ts, policy, approver });
    return ts;
  },
}));

const { getOrCreateMemorySession } = await import("./agentSession.js");

const sandbox = mkdtempSync(join(tmpdir(), "mcp-attach-"));
let n = 0;

const providerConfig = {
  type: "deepseek",
  model: "deepseek-chat",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "test-key",
} as unknown as ProviderConfig;

const AGENT = {
  name: "code",
  displayName: "Code",
  description: "",
  systemPrompt: "",
  maxSteps: 5,
  permissions: { allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: true },
} as AgentConfig;

/** A session of its own for every case: the cache is keyed by memoryDir, and a
 *  cached hit skips the attach loop entirely. */
function attach(
  mcpServers: Record<string, unknown>,
  onSystemMessage?: (content: string) => void,
  onMcpConnect?: (name: string) => void | Promise<void>,
  memoryDir?: string,
): ReturnType<typeof getOrCreateMemorySession> {
  return getOrCreateMemorySession({
    providerConfig,
    agentConfig: AGENT,
    workingDir: sandbox,
    memoryDir: memoryDir ?? join(sandbox, `m${n++}`),
    mcpServers: mcpServers as never,
    onSystemMessage,
    onMcpConnect,
  });
}

beforeEach(() => {
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  attached.length = 0;
  gated.length = 0;
  log.length = 0;
  serverThrows = null;
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("an MCP server is attached, named and gated", () => {
  test("the server's name travels in its config", async () => {
    await attach({ numbers: { command: "bun", args: ["server.ts"] } });

    expect(attached.length).toBe(1);
    // Required by the engine, and not sent to the server: it is what qualifies
    // every tool as `mcp__numbers__add`, which is what the model is offered
    // and what a permission rule has to name.
    const [request] = attached;
    expect(request?.config.name).toBe("numbers");
    expect(request?.config.transport).toBe("stdio");
    expect(request?.config.command).toBe("bun");
    expect(request?.config.args).toEqual(["server.ts"]);
  });

  test("the tool set is wrapped with both halves of the gate", async () => {
    await attach({ numbers: { command: "bun" } });

    expect(gated.length).toBe(1);
    const [wrapped] = gated;
    expect(wrapped?.ts).toBe(attached[0]?.ts);
    expect(typeof wrapped?.policy).toBe("function");
    // Without this argument the engine fails closed on every undecided call:
    // the server would appear to be broken rather than unapproved.
    expect(typeof wrapped?.approver).toBe("function");
  });

  test("a disabled server is not attached", async () => {
    await attach({ numbers: { command: "bun", enabled: false } });
    expect(attached.length).toBe(0);
  });
});

/**
 * The connect is synchronous and uninterruptible, so the UI cannot be told
 * *during* it — only before. This is the hook that makes that possible, and
 * the properties that matter are that it is awaited (a fire-and-forget
 * callback would repaint too late to be painted at all) and that it fires
 * before the connect rather than after.
 */
describe("the caller is told before the thread blocks", () => {
  test("each server is announced, by name, before it is contacted", async () => {
    const announced: string[] = [];
    await attach(
      { numbers: { command: "bun" }, files: { command: "bun" } },
      undefined,
      (name) => { announced.push(name); },
    );

    expect(announced).toEqual(["numbers", "files"]);
    // In the fake's log, so this is order and not just membership.
    expect(log).toEqual(["connect:numbers", "connect:files"]);
  });

  test("the announcement is awaited before the connect begins", async () => {
    await attach({ numbers: { command: "bun" } }, undefined, async (name) => {
      log.push(`announce:${name}:start`);
      await new Promise((r) => setTimeout(r, 1));
      log.push(`announce:${name}:end`);
    });

    // The yield is the whole point: without the await, `connect` would land
    // between `start` and `end` — or before both — and the frame that says
    // what is happening would never be painted.
    expect(log).toEqual(["announce:numbers:start", "announce:numbers:end", "connect:numbers"]);
  });

  test("a disabled server is not announced", async () => {
    const announced: string[] = [];
    await attach({ numbers: { command: "bun", enabled: false } }, undefined, (name) => { announced.push(name); },
    );
    expect(announced).toEqual([]);
  });

  test("a server that will not start is announced first, then reported", async () => {
    serverThrows = new Error("MCP: failed to spawn server process 'bun'");
    const announced: string[] = [];
    const messages: string[] = [];

    await attach({ numbers: { command: "bun" } }, (m) => { messages.push(m); }, (name) => { announced.push(name); },
    );

    // Announced, so a hang here is attributable — and a failure is not a hang,
    // so the announcement is followed by the usual report.
    expect(announced).toEqual(["numbers"]);
    expect(messages.length).toBe(1);
  });

  test("the cache hit that every later turn takes announces nothing", async () => {
    // The common path must stay silent: a per-turn "Connecting…" flicker would
    // be a lie about what the turn is doing.
    const memoryDir = join(sandbox, "m-cached");
    const announced: string[] = [];

    await attach({ numbers: { command: "bun" } }, undefined, (n) => { announced.push(n); }, memoryDir);
    expect(announced).toEqual(["numbers"]);

    await attach({ numbers: { command: "bun" } }, undefined, (n) => { announced.push(n); }, memoryDir);
    expect(announced).toEqual(["numbers"]);
    expect(log).toEqual(["connect:numbers"]);
  });
});

describe("an attach that cannot happen is reported, not swallowed", () => {
  test("a server that will not start says why", async () => {
    serverThrows = new Error("MCP: failed to spawn server process 'bun': not found");
    const messages: string[] = [];

    await attach({ numbers: { command: "bun" } }, (m) => { messages.push(m); });

    expect(attached.length).toBe(0);
    expect(gated.length).toBe(0);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("numbers");
    expect(messages[0]).toContain("not found");
  });

  test("one bad server does not take the good ones with it", async () => {
    const messages: string[] = [];
    await attach({ good: { command: "bun" }, bad: { command: "nope" } }, (m) => { messages.push(m); });

    expect(attached.map((a) => a.config.name)).toEqual(["good"]);
    expect(gated.length).toBe(1);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("bad");
  });
});

/**
 * The hook is only worth having if the two front ends use it — and a hook
 * nobody passes is exactly the shape of defect this codebase keeps producing,
 * since no test of the session alone would notice its absence.
 */
describe("wiring", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

  test("both TUI session builds announce, and both stop announcing after", () => {
    const app = read("../../components/App.tsx");
    // The turn's build and the overload retry's build: the retry has its own
    // cache key, so it contacts the servers again.
    expect(app.match(/onMcpConnect: announceMcpConnect/g)?.length).toBe(2);
    expect(app.match(/setMcpConnecting\(null\)/g)?.length).toBe(2);
    // The announcement is only ever painted if it yields to the renderer: a
    // state update queued in the same synchronous run as the blocking call is
    // batched away and never committed.
    expect(app).toContain("setMcpConnecting(name);");
    expect(app).toContain("await yieldToRenderer();");
  });

  test("the TUI shows which server, in the line that is already there", () => {
    const app = read("../../components/App.tsx");
    // Not a new banner: the spinner owns "what is happening right now", and
    // its elapsed counter is the only sign of how long a hang has lasted.
    expect(app).toContain("`Connecting to MCP server \"${mcpConnecting}\"…`");
    const spinner = app.indexOf("<Spinner");
    const label = app.indexOf("mcpConnecting\n                ? `Connecting");
    expect(label).toBeGreaterThan(spinner);
    expect(label - spinner).toBeLessThan(600);
  });

  test("a changed server list reaches the memoized submit handler", () => {
    const app = read("../../components/App.tsx");
    // The handler reads `mcpServers` from its closure and builds the session
    // from it. Without the dependency the first turn after the list changes —
    // trusting a project that declares MCP servers, for instance — uses the
    // list it had before, while the system message says otherwise.
    //
    // Scoped to the handler: another callback in this file lists `mcpServers`
    // among its dependencies, and a bare file-wide search is satisfied by it.
    const start = app.indexOf("const submitUserPrompt = useCallback(");
    expect(start).toBeGreaterThan(0);
    const handler = app.slice(start, app.indexOf("\n  );", start));
    expect(handler).toContain("\n      mcpServers,\n");
  });

  test("headless says it on stderr, where there is no repaint to wait for", () => {
    const print = read("../../cli/print.ts");
    expect(print).toContain("onMcpConnect:");
    expect(print).toContain("[mcp] connecting to");
    // Unconditional: a hang is most likely on the run nobody is watching.
    expect(print).not.toContain("if (verbose) process.stderr.write(`[mcp]");
  });
});

/**
 * The session key is what stands between a setting and the session it is
 * supposed to change. A cached entry is handed back whole — same tools, same
 * instructions — so anything the build reads that the key does not name is a
 * control that does nothing until the process restarts, while the UI keeps
 * saying it took effect. `/mcp enable|disable` is the one users hit first,
 * because the toggle is in the app and its copy promises the next message.
 *
 * Two properties, and both have to hold: a changed list must produce a
 * different session, and an unchanged one must produce the *same* session —
 * a key that never repeats is a rebuild on every turn, which re-spawns every
 * MCP server and replays the conversation each time.
 */
describe("the session key names what the session is built from", () => {
  test("a server whose config changed is attached again, not reused", async () => {
    const dir = join(sandbox, "reconfigured");
    await attach({ numbers: { command: "bun", args: ["a.ts"] } }, undefined, undefined, dir);
    await attach({ numbers: { command: "bun", args: ["b.ts"] } }, undefined, undefined, dir);

    // The second turn got a session built from the second config: `bun b.ts`
    // is running, not the `bun a.ts` the cached session still holds a handle to.
    expect(attached.map((a) => (a.config.args as string[])[0])).toEqual(["a.ts", "b.ts"]);
  });

  test("an unchanged list is a cache hit", async () => {
    const dir = join(sandbox, "unchanged");
    const first = await attach({ numbers: { command: "bun" } }, undefined, undefined, dir);
    const second = await attach({ numbers: { command: "bun" } }, undefined, undefined, dir);

    expect(second.session).toBe(first.session);
    expect(attached.length).toBe(1);
  });

  test("turning a server off hands back a session without it", async () => {
    const dir = join(sandbox, "toggled-off");
    const on = await attach({ numbers: { command: "bun" } }, undefined, undefined, dir);
    const off = await attach({ numbers: { command: "bun", enabled: false } }, undefined, undefined, dir);

    // The cached session has the server's tools on it and the server process
    // running behind them; `/mcp disable` promises the next message does not.
    expect(off.session).not.toBe(on.session);
  });

  test("a list that is entirely switched off is a session with no servers", async () => {
    const dir = join(sandbox, "all-off");
    const bare = await attach({}, undefined, undefined, dir);
    const disabled = await attach(
      { numbers: { command: "bun", enabled: false } },
      undefined,
      undefined,
      dir,
    );

    // Same key, because it is the same session: no servers either way. Hashing
    // the flag instead would rebuild the conversation to reach an identical
    // agent.
    expect(disabled.session).toBe(bare.session);
  });

  test("the same servers listed in another order are the same session", async () => {
    const dir = join(sandbox, "reordered");
    // Reordering keys in a config file is not a change to the config, and the
    // key is built from object *keys* — so it has to be ordered before it is
    // joined, or tidying up the file restarts every server and replays the
    // conversation to reach an identical agent.
    const first = await attach({ alpha: { command: "bun" }, beta: { command: "bun" } }, undefined, undefined, dir);
    const second = await attach({ beta: { command: "bun" }, alpha: { command: "bun" } }, undefined, undefined, dir);

    expect(second.session).toBe(first.session);
  });

  test("changing the output style rebuilds the session that composed it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcp-attach-settings-"));
    const settingsPath = join(dataDir, "settings.json");
    // Distinct mtimes: `loadSettings` caches against the file's, and two writes
    // in the same millisecond would serve the first value back.
    const writeStyle = (outputStyle: string, at: number) => {
      writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 2, outputStyle }));
      utimesSync(settingsPath, at, at);
    };

    process.env.DEEPSEEK_CODE_DATA_DIR = dataDir;
    try {
      const dir = join(sandbox, "restyled");
      writeStyle("concise", 1_700_000_000);
      const before = await attach({}, undefined, undefined, dir);
      writeStyle("explanatory", 1_700_000_100);
      const after = await attach({}, undefined, undefined, dir);

      // The style is composed into the instructions, which are fixed at build
      // time — so a cached session would keep answering in the old one.
      expect(after.session).not.toBe(before.session);
      expect(after.agent).not.toBe(before.agent);
    } finally {
      delete process.env.DEEPSEEK_CODE_DATA_DIR;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
