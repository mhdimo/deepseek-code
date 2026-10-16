/**
 * `deepseek-code acp` — the Agent side of the Agent Client Protocol, spoken as
 * newline-delimited JSON-RPC over stdio.
 *
 * The client here is the DeepSeek Harness (`dsh`): its `subagent-acp` backend
 * spawns this process as a child and drives it with `initialize` →
 * `session/new` → `session/prompt`, folding the `agent_message_chunk` text
 * into the subagent's answer. Nothing of dsh runs in this process, and nothing
 * of this file changes the engine: the turn itself is the same native
 * Agent+Session `--print` and the TUI drive, reached through
 * `getOrCreateMemorySession()`. This module is a mouth, not a brain.
 *
 * What the protocol needs from us, and where it comes from:
 *
 *   - `session/new` hands us a cwd. The native session is built there, and
 *     built *now* — so a bad model or a dead endpoint fails the session
 *     instead of the first prompt.
 *   - `session/prompt` streams the turn out as `session/update`
 *     notifications: text, reasoning, and tool-call cards. The stop reason is
 *     the same story `--print` tells: `end_turn` for a clean finish,
 *     `max_turn_requests` when the step budget ran out (dsh reports it as a
 *     failure — correctly, the answer is probably truncated), `max_tokens`
 *     when the model hit its output cap, and `cancelled` after
 *     `session/cancel`.
 *   - Permissions are the client's call. Every tool the engine asks about
 *     becomes a `session/request_permission` request, and the client's answer
 *     decides: dsh's default `permission: 'reject'` policy answers
 *     `cancelled`, so nothing runs unless its config says otherwise.
 *   - An engine error rejects the `session/prompt` request. Never a fake
 *     chunk: a caller that gets `end_turn` can trust that the turn ended.
 *
 * stdout is protocol-only. Everything diagnostic goes to stderr.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  agent as createAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type {
  AgentApp,
  AgentContext,
  ContentBlock,
  PromptResponse,
  SessionUpdate,
  StopReason,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { Session as NativeSession, StreamEvent } from "ai-sdk-cpp";
import type { PermissionCallback } from "../Tool.js";
import type { MCPServerConfig, ProviderConfig } from "../types/index.js";
import { finishReasonOf } from "../services/query.js";
import { emptyTurnMessage, isEmptyTurn } from "../services/recovery.js";
import { reachedStepLimit } from "../services/stepLimit.js";

/** Same bound `--print` puts on draining background-task news (see print.ts). */
const MAX_NOTIFICATION_TURNS = 4;

/**
 * What the protocol core needs from a session's engine.
 *
 * The split exists so the wire behavior can be tested without the native
 * binding: the tests inject a scripted runtime and assert what the client
 * saw, and `runAcp` supplies the real one.
 */
export interface AcpRuntimeParams {
  /** The ACP session id — also the engine session's cache-key salt. */
  sessionId: string;
  /** The client's working directory for this session (dsh passes its own). */
  cwd: string;
  /** The bridge to the client, already bound to this session. */
  requestPermission: PermissionCallback;
}

export interface AcpSessionRuntime {
  /** The engine's step budget — the handler reports exhaustion against it. */
  maxSteps: number;
  send(prompt: string): AsyncGenerator<StreamEvent>;
  /** Stop the turn in flight. The consumer still breaks its own loop. */
  abort(): void;
  /** Drop the engine session. Idempotent. */
  dispose(): void;
}

export interface AcpAgentOptions {
  /** Our own version, reported in `initialize` as `agentInfo.version`. */
  version: string;
  /** The model id, for the empty-turn error message. */
  model?: string;
  createRuntime(
    params: AcpRuntimeParams,
  ): Promise<AcpSessionRuntime> | AcpSessionRuntime;
}

export interface AcpAgent {
  app: AgentApp;
  /** Abort and release every session. Safe to call more than once. */
  shutdown(): void;
}

interface AcpSessionState {
  runtime: AcpSessionRuntime;
  /** `session/cancel` arrived: the turn stops at its next event. */
  cancelled: boolean;
  /** One prompt at a time per session. */
  busy: boolean;
}

/**
 * Builds the agent-side app: the same handlers in every deployment, with the
 * engine (or a fake) supplied by the caller.
 */
export function createAcpAgent(opts: AcpAgentOptions): AcpAgent {
  const sessions = new Map<string, AcpSessionState>();
  const app = createAgentApp({ name: "deepseek-code" });

  app.onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "deepseek-code", version: opts.version },
    // No auth flows to advertise: the key arrives in the environment the
    // client spawned us with, so there is nothing for the client to call.
    authMethods: [],
  }));

  app.onRequest(methods.agent.session.new, async (ctx) => {
    const sessionId = randomUUID();
    const state: AcpSessionState = {
      runtime: undefined as unknown as AcpSessionRuntime,
      cancelled: false,
      busy: false,
    };

    // The permission bridge. Captured here, but it fires later — during
    // `session/prompt`, from inside the engine's tool loop; an AgentContext
    // is connection-scoped, so it keeps working outside its own request.
    let permissionSeq = 0;
    const requestPermission: PermissionCallback = async (toolName, description, input) => {
      const title = resolveDescription(description) || toolName;
      try {
        const response = await ctx.client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId: `${sessionId}:perm:${++permissionSeq}`,
            title,
            kind: toolKindFor(toolName),
            rawInput: input ?? null,
          },
          options: [
            { optionId: "allow_once", name: "Allow", kind: "allow_once" },
            { optionId: "reject_once", name: "Reject", kind: "reject_once" },
          ],
        });
        if (response.outcome.outcome === "selected") {
          const optionId = response.outcome.optionId;
          if (optionId === "allow_once" || optionId === "allow_always") {
            return { approved: true };
          }
          return { approved: false, feedback: "The client denied this tool call." };
        }
        // dsh's `permission: 'reject'` policy answers exactly this, and the
        // wording matters: the model sees it as the tool result and needs to
        // understand the call was refused, not broken.
        return {
          approved: false,
          feedback: "The client cancelled the permission request; the tool did not run.",
        };
      } catch (err) {
        return {
          approved: false,
          feedback: `The permission request failed: ${errorMessage(err)}`,
        };
      }
    };

    // Let a runtime that cannot start reject `session/new` — the client asked
    // for a session and is owed an error, not a session that fails at use.
    state.runtime = await opts.createRuntime({
      sessionId,
      cwd: ctx.params.cwd,
      requestPermission,
    });
    sessions.set(sessionId, state);
    return { sessionId };
  });

  app.onRequest(methods.agent.session.prompt, async (ctx) => {
    const state = sessions.get(ctx.params.sessionId);
    if (!state) {
      throw RequestError.invalidParams(undefined, `Unknown session: ${ctx.params.sessionId}`);
    }
    if (state.busy) {
      throw RequestError.invalidParams(
        undefined,
        "This session is already running a prompt. Cancel it, or wait for it to finish.",
      );
    }
    state.busy = true;
    state.cancelled = false;
    try {
      return await runTurn({
        client: ctx.client,
        signal: ctx.signal,
        sessionId: ctx.params.sessionId,
        state,
        prompt: ctx.params.prompt,
        model: opts.model,
      });
    } finally {
      state.busy = false;
    }
  });

  app.onNotification(methods.agent.session.cancel, (ctx) => {
    const state = sessions.get(ctx.params.sessionId);
    if (!state) return;
    state.cancelled = true;
    state.runtime.abort();
  });

  const shutdown = () => {
    for (const [sessionId, state] of sessions) {
      try {
        state.runtime.abort();
        state.runtime.dispose();
      } catch {
        // Disposal is best-effort; the connection is going away regardless.
      }
      sessions.delete(sessionId);
    }
  };

  return { app, shutdown };
}

/** A connected stdio server. `closed` resolves after every session is released. */
export interface AcpServerConnection {
  readonly closed: Promise<void>;
}

/**
 * Serves one client over a pair of byte streams (in `runAcp`: process stdio).
 *
 * The returned `closed` resolves only after `shutdown()` has run, so a caller
 * that awaits it — and a test that does — sees a fully released agent.
 */
export function connectAcp(
  opts: AcpAgentOptions,
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): AcpServerConnection {
  const handle = createAcpAgent(opts);
  const connection = handle.app.connect(ndJsonStream(output, input));
  // Input ending (the client closed stdin — dsh's first rung in its dispose
  // ladder) closes the connection; releasing the engine sessions is ours.
  return { closed: connection.closed.then(() => handle.shutdown()) };
}

export interface AcpOptions {
  version: string;
  providerConfig: ProviderConfig;
  /** Fallback for a `session/new` whose cwd is empty. */
  workingDir: string;
  memoryDir?: string;
  maxContextTokens?: number;
  mcpServers?: Record<string, MCPServerConfig>;
  agent?: "code" | "plan" | "review";
}

/** Run the stdio server until the client goes away. Returns the exit code. */
export async function runAcp(opts: AcpOptions): Promise<number> {
  if (!opts.providerConfig.apiKey) {
    process.stderr.write(
      "deepseek-code acp: no API key configured. Set DEEPSEEK_API_KEY (or configure one " +
        "in ~/.deepseek-code/settings.json) in the environment the harness spawns this " +
        "process with.\n",
    );
    return 1;
  }

  const createRuntime = await createEngineRuntime(opts);
  const connection = connectAcp(
    { version: opts.version, model: opts.providerConfig.model, createRuntime },
    new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          process.stdout.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()));
        });
      },
    }),
    new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        process.stdin.on("end", () => controller.close());
        process.stdin.on("error", (err) => controller.error(err));
      },
    }),
  );
  await connection.closed;
  return 0;
}

/**
 * The real runtime: one native memory session per ACP session, keyed so
 * concurrent sessions never share engine state.
 */
async function createEngineRuntime(opts: AcpOptions) {
  const [{ getOrCreateMemorySession, releaseMemorySession }, { agentManager }, notifications] =
    await Promise.all([
      import("../services/agent/agentSession.js"),
      import("../services/agent/index.js"),
      import("../services/tasks/notifications.js"),
    ]);
  const { formatTaskNotifications, takeTaskNotifications, pendingTaskNotificationCount } =
    notifications;

  return async (params: AcpRuntimeParams): Promise<AcpSessionRuntime> => {
    const agentConfig = agentManager.getConfig(opts.agent ?? "code");
    const workingDir = params.cwd || opts.workingDir;
    const maxSteps = agentConfig.maxSteps || 25;
    // A fresh controller per turn: `session/cancel` aborts the turn in
    // flight, and an already-aborted controller would poison the next one.
    let controller = new AbortController();
    let native: NativeSession | null = null;
    let disposed = false;

    const attach = async (): Promise<NativeSession> => {
      const { session } = await getOrCreateMemorySession({
        onMcpConnect: (name) => {
          process.stderr.write(`[mcp] connecting to "${name}"…\n`);
        },
        providerConfig: opts.providerConfig,
        agentConfig,
        workingDir,
        memoryDir: opts.memoryDir ?? `${homedirSafe()}/.deepseek-code/memory`,
        maxContextTokens: opts.maxContextTokens,
        requestPermission: params.requestPermission,
        mcpServers: opts.mcpServers,
        abortController: controller,
        // Unique per ACP session: two sessions in one process must not share
        // one engine session (history, memory, working directory).
        sessionKey: `acp:${params.sessionId}`,
      });
      native = session;
      return session;
    };

    // Build now, so a dead key or endpoint fails `session/new`. The cache
    // makes the per-turn `attach()` calls below cheap hits that only refresh
    // the controller and the permission callback.
    await attach();

    return {
      maxSteps,
      async *send(prompt: string) {
        let next = prompt;
        // A background task that finished while the turn ran is news the
        // model has not seen — the same contract the TUI and `--print` keep.
        // Each drained round is another send, so it is bounded.
        for (let round = 0; ; round++) {
          controller = new AbortController();
          const session = await attach();
          let steps = 0;
          for await (const ev of session.sendStream(next) as AsyncGenerator<StreamEvent>) {
            yield ev;
            if (ev.type === "finish" && finishReasonOf(ev) === "tool_calls") steps += 1;
          }
          // A round that spent the whole budget stops here, exactly as
          // `--print` stops: the handler reports the truncation.
          if (reachedStepLimit(steps, maxSteps)) break;
          const news = formatTaskNotifications(takeTaskNotifications());
          if (!news) break;
          if (round >= MAX_NOTIFICATION_TURNS) {
            const pending = pendingTaskNotificationCount();
            if (pending > 0) {
              process.stderr.write(
                `[task] ${pending} background-task notification(s) were not delivered: ` +
                  `the turn already used its ${MAX_NOTIFICATION_TURNS} follow-up rounds.\n`,
              );
            }
            break;
          }
          next = news;
        }
      },
      abort() {
        controller.abort();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          if (native) releaseMemorySession(native);
        } catch {
          // Already evicted by the LRU — nothing left to release.
        }
      },
    };
  };
}

/** One turn: engine events → `session/update` notifications → stop reason. */
async function runTurn(args: {
  client: AgentContext;
  signal: AbortSignal;
  sessionId: string;
  state: AcpSessionState;
  prompt: ContentBlock[];
  model?: string;
}): Promise<PromptResponse> {
  const { client, signal, sessionId, state, model } = args;
  const text = promptText(args.prompt);
  const send = (update: SessionUpdate) =>
    client.notify(methods.client.session.update, { sessionId, update });

  let nextToolId = 0;
  /** Tool calls seen but not yet finished: id → name and streamed arguments. */
  const inflight = new Map<string, { name: string; args: string }>();
  let steps = 0;
  let outputEvents = 0;
  let totalTokens = 0;
  let finishReason = "";

  for await (const ev of state.runtime.send(text)) {
    // `state.cancelled` is set by the `session/cancel` notification handler,
    // which also calls `runtime.abort()`. This check is what makes the stop
    // land *here* — the engine has no interrupt of its own (see query.ts).
    if (state.cancelled || signal.aborted) break;

    switch (ev.type) {
      case "text_delta": {
        const chunk = ev.text ?? "";
        if (!chunk) break;
        outputEvents += 1;
        await send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        });
        break;
      }
      case "reasoning_delta": {
        const chunk = ev.text ?? "";
        if (!chunk) break;
        await send({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: chunk },
        });
        break;
      }
      case "tool_call_start": {
        outputEvents += 1;
        const id = ev.toolCallId || `tool-${++nextToolId}`;
        const name = ev.toolName || "(unknown)";
        inflight.set(id, { name, args: "" });
        await send({
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: name,
          kind: toolKindFor(name),
          status: "pending",
        });
        break;
      }
      case "tool_call_delta": {
        const entry = ev.toolCallId ? inflight.get(ev.toolCallId) : undefined;
        if (entry) entry.args += ev.text ?? "";
        break;
      }
      case "tool_call_end": {
        const id = ev.toolCallId;
        if (!id) break;
        // The arguments streamed in as text; the card gets them parsed, in
        // one update, rather than as a half-written JSON string.
        const rawInput = parseToolInput(inflight.get(id)?.args ?? "");
        await send({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "in_progress",
          ...(rawInput !== undefined ? { rawInput } : {}),
        });
        break;
      }
      case "tool_result": {
        const id = ev.toolCallId || "";
        if (!id) break;
        inflight.delete(id);
        await send({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "completed",
          rawOutput: ev.text ?? "",
        });
        break;
      }
      case "finish": {
        // One `finish` per model call; a call that asked for a tool is a
        // step, and the turn continues from it (see services/stepLimit.ts).
        const reason = finishReasonOf(ev);
        if (reason) finishReason = reason;
        if (reason === "tool_calls") steps += 1;
        if (ev.usage) totalTokens = ev.usage.inputTokens + ev.usage.outputTokens;
        break;
      }
      case "error": {
        // The caller gets a rejection, not a silent `end_turn` over a dead
        // turn: "printed an answer and stopped" and "the API fell over" must
        // not look the same to the harness. A RequestError, not a plain
        // Error — the connection layer replaces a plain Error's message with
        // a bare "Internal error", and the reason is the whole point.
        throw RequestError.internalError(undefined, ev.text || "the engine reported an error");
      }
      default:
        break;
    }
  }

  if (state.cancelled || signal.aborted) return { stopReason: "cancelled" };
  // Exhaustion is a warning the client is owed, not a clean finish — dsh
  // reports `max_turn_requests` as a failure and that is the honest reading.
  if (reachedStepLimit(steps, state.runtime.maxSteps)) {
    return { stopReason: "max_turn_requests" };
  }
  if (finishReason === "length" || finishReason === "max_tokens") {
    return { stopReason: "max_tokens" };
  }
  // A turn that produced nothing is indistinguishable from a completed one
  // on the wire — same argument as `--print` (see services/recovery.ts).
  // RequestError for the same reason as the engine error above: the message
  // has to survive the connection layer.
  if (isEmptyTurn(totalTokens, outputEvents)) {
    throw RequestError.internalError(undefined, emptyTurnMessage(model));
  }
  return { stopReason: "end_turn" };
}

/** The prompt's text. The engine takes a string; non-text blocks are dropped. */
function promptText(blocks: ContentBlock[] | undefined): string {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    if (block.type === "text") parts.push(block.text);
  }
  const text = parts.join("\n").trim();
  if (!text) {
    throw RequestError.invalidParams(undefined, "The prompt carried no text content.");
  }
  return text;
}

/** The tool-call arguments as an object, or nothing if they never parsed. */
function parseToolInput(argsText: string): unknown {
  if (!argsText.trim()) return undefined;
  try {
    return JSON.parse(argsText);
  } catch {
    return undefined;
  }
}

/** The permission card's description is a lazy thunk in some tools. */
function resolveDescription(description: string | (() => string)): string {
  if (typeof description !== "function") return description;
  try {
    return description();
  } catch {
    return "";
  }
}

/** A tool's family, for the client's icon and grouping. */
export function toolKindFor(toolName: string): ToolKind {
  switch (toolName) {
    case "Read":
    case "LS":
    case "LSP":
      return "read";
    case "Glob":
    case "Grep":
      return "search";
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "PowerShell":
    case "REPL":
      return "execute";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
      return "think";
    default:
      return "other";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function homedirSafe(): string {
  try {
    return homedir();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || "/tmp";
  }
}
