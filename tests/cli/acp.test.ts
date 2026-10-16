/**
 * The ACP mode's protocol behavior, driven by the SDK's own client side.
 *
 * `src/cli/acp.ts` is a mouth, not a brain: the turn itself comes from the
 * engine, so every test here injects a scripted runtime and asserts what the
 * wire saw. The client in these tests is the same `@agentclientprotocol/sdk`
 * client app the DeepSeek Harness's `subagent-acp` backend builds, so a
 * passing suite means wire compatibility by construction, not by imitation.
 */

import { describe, expect, test } from "bun:test";
import {
  client as createClientApp,
  methods,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { ActiveSession, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { StreamEvent } from "ai-sdk-cpp";
import {
  connectAcp,
  createAcpAgent,
  type AcpAgentOptions,
  type AcpRuntimeParams,
} from "../../src/cli/acp.js";

type TurnScript = (params: AcpRuntimeParams) => AsyncGenerator<StreamEvent>;

interface Fake {
  options: AcpAgentOptions;
  params: AcpRuntimeParams[];
  promptTexts: string[];
  isAborted: () => boolean;
  isDisposed: () => boolean;
  /** Resolved by abort() — lets a script park mid-turn until cancel arrives. */
  abortGate: Promise<void>;
}

/** A scripted runtime: yields the events verbatim, records aborts/disposals. */
function makeAgent(opts: { script: TurnScript; maxSteps?: number }): Fake {
  const params: AcpRuntimeParams[] = [];
  const promptTexts: string[] = [];
  let aborted = false;
  let disposed = false;
  let openGate: () => void = () => {};
  const abortGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const options: AcpAgentOptions = {
    version: "0.0.0-test",
    createRuntime: async (p) => {
      params.push(p);
      return {
        maxSteps: opts.maxSteps ?? 25,
        send(prompt: string) {
          promptTexts.push(prompt);
          return opts.script(p);
        },
        abort() {
          aborted = true;
          openGate();
        },
        dispose() {
          disposed = true;
        },
      };
    },
  };
  return {
    options,
    params,
    promptTexts,
    isAborted: () => aborted,
    isDisposed: () => disposed,
    abortGate,
  };
}

async function* scripted(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

/** Prompt, then read updates until the turn's stop message. */
async function collectTurn(session: ActiveSession): Promise<{
  updates: SessionUpdate[];
  stopReason: StopReason;
}> {
  const updates: SessionUpdate[] = [];
  for (;;) {
    const m = await session.nextUpdate();
    if (m.kind === "stop") return { updates, stopReason: m.stopReason };
    updates.push(m.update);
  }
}

function textOf(update: SessionUpdate): string {
  return update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
    ? update.content.text
    : "";
}

/** Drive one full prompt turn against the faked agent and return the wire. */
async function runTurn(
  fake: Fake,
  prompt: string,
  configureClient?: (
    app: ReturnType<typeof createClientApp>,
  ) => ReturnType<typeof createClientApp>,
): Promise<{ updates: SessionUpdate[]; stopReason: StopReason }> {
  const app = configureClient
    ? configureClient(createClientApp({ name: "test" }))
    : createClientApp({ name: "test" });
  return app.connectWith(makeApp(fake), async (ctx: any) => {
    const session = await ctx.buildSession("/tmp/x").start();
    const p = session.prompt(prompt);
    const collected = await collectTurn(session);
    await p;
    session.dispose();
    return collected;
  });
}

function makeApp(fake: Fake) {
  return createAcpAgent(fake.options).app;
}

describe("acp initialize", () => {
  test("answers the handshake with the protocol version and agent info", async () => {
    const fake = makeAgent({ script: () => scripted([]) });
    const result = await createClientApp({ name: "test" }).connectWith(
      makeApp(fake),
      (ctx: any) =>
        ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
    );
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.agentInfo?.name).toBe("deepseek-code");
    expect(result.agentInfo?.version).toBe("0.0.0-test");
    // No auth flows: the key arrives in the environment, so there is nothing
    // for the client to call.
    expect(result.authMethods ?? []).toEqual([]);
  });
});

describe("acp sessions", () => {
  test("session/new returns an id and hands the runtime the cwd and a permission bridge", async () => {
    const fake = makeAgent({ script: () => scripted([]) });
    const sessionId = await createClientApp({ name: "test" }).connectWith(
      makeApp(fake),
      async (ctx: any) => {
        const session = await ctx.buildSession("/tmp/acp-cwd").start();
        session.dispose();
        return session.sessionId as string;
      },
    );
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);
    expect(fake.params).toHaveLength(1);
    expect(fake.params[0]!.cwd).toBe("/tmp/acp-cwd");
    expect(typeof fake.params[0]!.requestPermission).toBe("function");
  });

  test("a runtime that cannot start rejects session/new", async () => {
    const agent = createAcpAgent({
      version: "0.0.0-test",
      createRuntime: async () => {
        throw new Error("no api key configured");
      },
    });
    await expect(
      createClientApp({ name: "test" }).connectWith(agent.app, (ctx: any) =>
        ctx.buildSession("/tmp/x").start(),
      ),
    ).rejects.toThrow();
  });

  test("a prompt for an unknown session is an error", async () => {
    const fake = makeAgent({ script: () => scripted([]) });
    await expect(
      createClientApp({ name: "test" }).connectWith(makeApp(fake), (ctx: any) =>
        ctx.request(methods.agent.session.prompt, {
          sessionId: "nope",
          prompt: [{ type: "text", text: "hi" }],
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("acp turn streaming", () => {
  test("text arrives as agent_message_chunk and the turn answers end_turn", async () => {
    const fake = makeAgent({
      script: () =>
        scripted([
          { type: "text_delta", text: "Hel" },
          { type: "text_delta", text: "lo" },
          { type: "finish", usage: { inputTokens: 10, outputTokens: 2 } },
        ]),
    });
    const turn = await runTurn(fake, "say hi");
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.updates.map(textOf)).toEqual(["Hel", "lo"]);
    expect(fake.promptTexts).toEqual(["say hi"]);
  });

  test("reasoning arrives as agent_thought_chunk", async () => {
    const fake = makeAgent({
      script: () =>
        scripted([
          { type: "reasoning_start" },
          { type: "reasoning_delta", text: "pondering" },
          { type: "reasoning_end" },
          { type: "text_delta", text: "done" },
          { type: "finish" },
        ]),
    });
    const turn = await runTurn(fake, "think");
    const thoughts = turn.updates.filter((u) => u.sessionUpdate === "agent_thought_chunk");
    expect(thoughts).toHaveLength(1);
    const thought = thoughts[0]!;
    expect(
      thought.sessionUpdate === "agent_thought_chunk" &&
        thought.content.type === "text" &&
        thought.content.text,
    ).toBe("pondering");
  });

  test("a tool call becomes a tool_call card that updates through completion", async () => {
    const fake = makeAgent({
      script: () =>
        scripted([
          { type: "tool_call_start", toolCallId: "t1", toolName: "Read" },
          { type: "tool_call_delta", toolCallId: "t1", text: '{"file_path":"/etc/hosts"}' },
          { type: "tool_call_end", toolCallId: "t1", toolName: "Read" },
          { type: "tool_result", toolCallId: "t1", text: "127.0.0.1 localhost" },
          { type: "finish" },
        ]),
    });
    const turn = await runTurn(fake, "read hosts");
    const start = turn.updates.find((u) => u.sessionUpdate === "tool_call");
    expect(start).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read",
      kind: "read",
      status: "pending",
    });
    const updates = turn.updates.filter((u) => u.sessionUpdate === "tool_call_update");
    const inProgress = updates.find(
      (u) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress",
    );
    expect(inProgress?.rawInput).toEqual({ file_path: "/etc/hosts" });
    const done = updates.find(
      (u) => u.sessionUpdate === "tool_call_update" && u.status === "completed",
    )!;
    expect(done.rawOutput).toBe("127.0.0.1 localhost");
  });

  test("an engine error rejects the prompt rather than faking an answer", async () => {
    const fake = makeAgent({
      script: () =>
        scripted([
          { type: "text_delta", text: "partial" },
          { type: "error", text: "upstream exploded" },
        ]),
    });
    await createClientApp({ name: "test" }).connectWith(makeApp(fake), async (ctx: any) => {
      const session = await ctx.buildSession("/tmp/x").start();
      await expect(session.prompt("boom")).rejects.toThrow(/upstream exploded/);
      session.dispose();
    });
  });

  test("a turn that produced nothing is an error, not a silent success", async () => {
    const fake = makeAgent({ script: () => scripted([{ type: "finish" }]) });
    await createClientApp({ name: "test" }).connectWith(makeApp(fake), async (ctx: any) => {
      const session = await ctx.buildSession("/tmp/x").start();
      await expect(session.prompt("silence")).rejects.toThrow();
      session.dispose();
    });
  });

  test("spending the whole step budget answers max_turn_requests", async () => {
    const stepFinish = (): StreamEvent => ({
      type: "finish",
      usage: { inputTokens: 5, outputTokens: 1, finishReason: "tool_calls" } as StreamEvent["usage"],
    });
    const fake = makeAgent({
      maxSteps: 3,
      script: () => scripted([stepFinish(), stepFinish(), stepFinish()]),
    });
    const turn = await runTurn(fake, "keep going");
    expect(turn.stopReason).toBe("max_turn_requests");
  });
});

describe("acp cancellation", () => {
  test("session/cancel stops the turn and answers cancelled", async () => {
    const fake = makeAgent({
      script: async function* () {
        yield { type: "text_delta", text: "first" } as StreamEvent;
        // Parked mid-turn until the cancel notification aborts the runtime.
        await fake.abortGate;
        yield { type: "text_delta", text: "never" } as StreamEvent;
        yield { type: "finish" } as StreamEvent;
      },
    });
    const result = await createClientApp({ name: "test" }).connectWith(
      makeApp(fake),
      async (ctx: any) => {
        const session = await ctx.buildSession("/tmp/x").start();
        const p = session.prompt("long job");
        const first = await session.nextUpdate();
        expect(first.kind === "session_update" && textOf(first.update)).toBe("first");
        await ctx.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
        const collected = await collectTurn(session);
        const response = await p;
        session.dispose();
        return { ...collected, response };
      },
    );
    expect(result.stopReason).toBe("cancelled");
    expect(result.response.stopReason).toBe("cancelled");
    expect(fake.isAborted()).toBe(true);
    expect(result.updates.map(textOf)).not.toContain("never");
  });
});

describe("acp permissions", () => {
  test("a tool asks the client, and an allow lets it proceed", async () => {
    const seen: Array<{ title: string; kind: unknown; options: unknown }> = [];
    const fake = makeAgent({
      script: async function* (params) {
        const decision = await params.requestPermission("Write", "Write src/x.ts", {
          file_path: "src/x.ts",
        });
        yield {
          type: "text_delta",
          text: decision.approved ? "approved" : "denied",
        } as StreamEvent;
        yield { type: "finish" } as StreamEvent;
      },
    });
    const turn = await runTurn(
      fake,
      "write the file",
      (app) =>
        app.onRequest(methods.client.session.requestPermission, ({ params }) => {
          seen.push({
            title: params.toolCall.title ?? "",
            kind: params.toolCall.kind,
            options: params.options,
          });
          const allow = params.options.find((o) => o.kind === "allow_once")!;
          return { outcome: { outcome: "selected", optionId: allow.optionId } };
        }),
    );
    expect(turn.updates.map(textOf)).toEqual(["approved"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.title).toBe("Write src/x.ts");
    expect(seen[0]!.kind).toBe("edit");
    expect((seen[0]!.options as Array<{ kind: string }>).map((o) => o.kind)).toContain(
      "allow_once",
    );
  });

  test("a cancelled permission denies that call and the turn carries on", async () => {
    const fake = makeAgent({
      script: async function* (params) {
        const decision = await params.requestPermission("Bash", "Run rm -rf", {
          command: "rm -rf /",
        });
        yield {
          type: "text_delta",
          text: decision.approved ? "ran" : `denied: ${decision.feedback ?? ""}`,
        } as StreamEvent;
        yield { type: "finish" } as StreamEvent;
      },
    });
    // This is exactly what the harness's `permission: 'reject'` policy answers.
    const turn = await runTurn(fake, "do it", (app) =>
      app.onRequest(methods.client.session.requestPermission, () => ({
        outcome: { outcome: "cancelled" } as const,
      })),
    );
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.updates.map(textOf).join("")).toMatch(/^denied: /);
  });
});

describe("acp transport", () => {
  test("serves newline-delimited JSON-RPC over a stream pair and shuts down on EOF", async () => {
    const fake = makeAgent({ script: () => scripted([]) });
    const enc = new TextEncoder();
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      },
      { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp/x", mcpServers: [] } },
    ];
    let feed: ReadableStreamDefaultController<Uint8Array> | null = null;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        feed = controller;
      },
    });
    const chunks: Uint8Array[] = [];
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    const connection = connectAcp(fake.options, output, input);
    // A real client (dsh) keeps stdin open until it has read every response —
    // its dispose ladder ends stdin only after the session is done.
    for (const r of requests) feed!.enqueue(enc.encode(JSON.stringify(r) + "\n"));
    await until(() => responsesOf(chunks).length >= 2);
    feed!.close();
    await connection.closed;

    const lines = responsesOf(chunks);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((l) => l.jsonrpc === "2.0")).toBe(true);
    const init = lines.find((l) => l.id === 1)!;
    expect(init.result?.protocolVersion).toBe(PROTOCOL_VERSION);
    const created = lines.find((l) => l.id === 2)!;
    expect(typeof created.result?.sessionId).toBe("string");
    // The EOF ladder: input ended, so every session is aborted and released.
    expect(fake.isDisposed()).toBe(true);
  });
});

function responsesOf(chunks: Uint8Array[]): Array<{ jsonrpc: string; id?: number; result?: any; error?: any }> {
  return new TextDecoder()
    .decode(concat(chunks))
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { jsonrpc: string; id?: number; result?: any; error?: any });
}

/** Poll a predicate until it holds; the streams settle on their own events. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the wire to settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
