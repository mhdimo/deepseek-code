








import {
  Agent,
  Session,
  mcpToolsetFromServer,
  supportsApprover,
  withPermissions,
  type StandardToolSet,
} from "ai-sdk-cpp";
import { createMcpPermissionGate } from "./mcpPermissions.js";
import { createReadState } from "../readState.js";
import { createModel } from "../provider/registry.js";
import { getTools, toolsToBindingFormat } from "../../tools.js";
import type { AskUserQuestionsCallback, ToolUseContext, PermissionCallback } from "../../Tool.js";
import type { AgentConfig, ProviderConfig, MCPServerConfig, TodoItem, TaskItem, Message } from "../../types/index.js";
import { appendMemoryFiles, memoryFileCandidates } from "../memoryFiles.js";
import { spawnSync } from "node:child_process";
import { assembleSystemPromptSync } from "../../constants/prompts.js";
import { composeWithSystemPrompt, loadCustomOutputStylesSync } from "../../services/outputStyles.js";
import { loadSettings } from "../../state/storage.js";
import { getEffortLevel, effortToProviderOptions } from "../effort.js";

export interface MemorySession {
  agent: Agent;
  session: Session;
  /** The context the tool wrapper closes over — the session's permissions,
   *  callbacks and plan state. Exposed so callers (and tests) can ask the
   *  session what it currently believes, instead of assuming. */
  context: ToolUseContext;
}

interface CacheEntry {
  key: string;
  ms: MemorySession;
  context: ToolUseContext;
  /** The caller's plan-mode provider, swappable on every call. The context
   *  closes over this box, so a cached session follows the UI's *current*
   *  permission mode rather than the one it happened to be built under. */
  isPlanMode: { current?: () => boolean };
}
// Multi-entry cache keyed by the session key string. The previous single-entry
// cache evicted the MAIN session whenever a subagent created its own session —
// the JS Agent wrapper (which owns the native ToolSet) then lost its last
// reference, GC ran its destructor mid-turn, and the native loop SIGTRAPped on
// the freed toolset. Entries stay referenced until explicitly released.
//
// Unbounded growth is still wrong: every agent/effort/model switch and every
// subagent run used to add a full native session (memory dir + context) for
// the process lifetime. The cache is now LRU-bounded with one hard rule —
// the entry most recently created or touched is NEVER evicted, and that
// entry is always the session the current turn is driving (submitUserPrompt
// only holds the session object, not the Agent wrapper, so evicting it
// mid-turn would re-expose the SIGTRAP). Older entries are only referenced
// by the cache, so dropping them is safe; subagent entries additionally hold
// their own MemorySession in the run frame until releaseMemorySession runs.
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 12;

function touchCache(key: string): void {
  // Map iteration order = insertion order; re-inserting moves the entry to
  // the newest position (LRU recency).
  const entry = cache.get(key);
  if (entry) {
    cache.delete(key);
    cache.set(key, entry);
  }
}

function trimCache(protectedKey: string): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    // Oldest entry first; never evict the just-used key.
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === protectedKey) break;
    cache.delete(oldest);
  }
}

/**
 * The MCP servers a build would actually attach, as a string.
 *
 * Part of the session key, because the servers are: each one contributes tools,
 * and a tool set is fixed when the Agent is constructed. `/mcp enable|disable`
 * says the change takes effect on the next message, and without this the
 * cached session answered with the servers it was built with — the toggle
 * looked like it had done nothing at all until the process restarted.
 *
 * Disabled servers are left out rather than hashed as disabled. A list where
 * every server is switched off *is* a session with no servers, and it should
 * share that session's entry instead of growing an entry of its own.
 *
 * The whole config, not just the name: editing a server's command or args in
 * the file is the same class of change (the still-cached session is running
 * the old process) and gets the same rebuild.
 */
export function mcpServersKey(mcpServers?: Record<string, MCPServerConfig>): string {
  if (!mcpServers) return "";
  return Object.keys(mcpServers)
    .filter((name) => mcpServers[name]?.enabled !== false)
    .sort()
    .map((name) => `${name}=${JSON.stringify(mcpServers[name])}`)
    .join(",");
}

/** The user's output-style setting, or undefined when it cannot be read. Read
 *  once per build: it is composed into the instructions below and it is part of
 *  the session key, and those two must be the same value. */
function readOutputStyle(): string | undefined {
  try {
    return loadSettings().outputStyle;
  } catch {
    return undefined;
  }
}

/**
 * Build the native Agent + Session for these options, or return the cached one.
 *
 * Async because building can mean *talking to a server*: `mcpToolsetFromServer`
 * spawns each configured MCP server and completes the handshake on the calling
 * thread. That is a synchronous native call — there is no timeout and no way to
 * cancel it — so on the submit path the UI thread is the one that stops, mid
 * keystroke, with nothing on screen to say why. Nothing here can interrupt the
 * block, but the reason for it can be on screen before it starts, which is what
 * `onMcpConnect` is for.
 *
 * A cache hit never suspends — it returns before the first `await` — so the
 * per-turn path keeps its old shape.
 */
export async function getOrCreateMemorySession(opts: {
  providerConfig: ProviderConfig;
  agentConfig: AgentConfig;
  workingDir: string;
  memoryDir: string;
  maxContextTokens?: number;
  requestPermission?: PermissionCallback;
  askUserQuestions?: AskUserQuestionsCallback;
  /**
   * Whether the UI is currently in plan mode (Shift+Tab).
   *
   * Plan mode exists twice in this app: the tool-entered one, which the
   * session owns via EnterPlanMode/ExitPlanMode, and the UI's permission mode.
   * Only the first was visible to the execute wrapper, so Shift+Tab's plan
   * mode was enforced solely inside the permission prompt — and an allow rule
   * skips the prompt, so it was enforced not at all. Read fresh on each call.
   */
  isPlanMode?: () => boolean;
  mcpServers?: Record<string, MCPServerConfig>;
  /**
   * Called once per MCP server, immediately before that server is contacted,
   * and awaited.
   *
   * The connect that follows is synchronous and uninterruptible, so a server
   * that accepts the connection and then never answers stops this call until
   * the OS times it out — which, on the way to a first message, means the app
   * stops repainting with no way to tell a hang from slow work. A caller that
   * returns a promise here gets to put the reason on screen first (the TUI
   * repaints on the yield; headless writes a line to stderr).
   */
  onMcpConnect?: (name: string) => void | Promise<void>;
  abortController?: AbortController;
  onToolResult?: (toolName: string, input: any, output: string, isError: boolean) => void;
  /** A call the permission layer refused, and why — see ToolUseContext. */
  onPermissionDenied?: (toolName: string, reason: string) => void;
  onToolOutput?: (toolName: string, text: string) => void;
  onToolActivity?: (toolName: string, input: Record<string, unknown>) => void;
  onTodosChange?: (todos: TodoItem[]) => void;
  onSystemMessage?: (content: string) => void;
  history?: Message[];
  /** Per-turn effort override (ultrathink keyword). Included in the cache key
   *  like the settings-level effort, so the override rebuilds the session for
   *  exactly this turn and the next turn reverts. */
  effortOverride?: string;
  /** Cache-key salt. Subagents pass a unique value to get their own fresh
   *  native session (concurrent-safe; evicts the cached entry). */
  sessionKey?: string;
}): Promise<MemorySession> {
  const { providerConfig, agentConfig, workingDir, memoryDir, maxContextTokens, requestPermission, askUserQuestions, abortController, onToolResult, onPermissionDenied, onToolOutput, onToolActivity, onTodosChange } = opts;



  const effort = (opts.effortOverride as ReturnType<typeof getEffortLevel> | undefined) ?? getEffortLevel();
  const providerOptions = effortToProviderOptions(effort);

  // Grants belong in the key: the tool pool is derived from them, and a
  // `.claude/agents/*.md` file edited between turns changes them without
  // changing the agent's name.
  const grants = (["allowRead", "allowWrite", "allowExecute", "allowNetwork"] as const)
    .map((flag) => (agentConfig.permissions[flag] ? "1" : "0"))
    .join("");
  const allowed = agentConfig.allowedTools ? agentConfig.allowedTools.join(",") : "*";
  const outputStyle = readOutputStyle();

  const key = [
    providerConfig.type, providerConfig.model || "", providerConfig.baseURL || "",
    workingDir, agentConfig.name, memoryDir,
    effort || "off",
    grants, allowed,
    outputStyle ?? "",
    mcpServersKey(opts.mcpServers),
    opts.sessionKey ?? "",
  ].join("|");
  const cached = cache.get(key);
  if (cached) {
    touchCache(key);
    if (requestPermission) {
      cached.context.requestPermission = requestPermission;
    }
    cached.context.askUserQuestions = askUserQuestions;
    if (abortController) {
      cached.context.abortController = abortController;
    }
    if (onToolResult) {
      cached.context.onToolResult = onToolResult;
    }
    if (onPermissionDenied) {
      cached.context.onPermissionDenied = onPermissionDenied;
    }
    if (onToolOutput) {
      cached.context.onToolOutput = onToolOutput;
    }
    if (onToolActivity) {
      cached.context.onToolActivity = onToolActivity;
    }
    if (onTodosChange) {
      cached.context.onTodosChange = onTodosChange;
    }
    if (opts.onSystemMessage) {
      cached.context.onSystemMessage = opts.onSystemMessage;
    }
    cached.isPlanMode.current = opts.isPlanMode;
    return cached.ms;
  }

  const model = createModel(providerConfig);

  
  
  let todos: TodoItem[] = [];
  let tasks: TaskItem[] = [];
  let planMode = false;
  const isPlanMode: { current?: () => boolean } = { current: opts.isPlanMode };

  const context: ToolUseContext = {
    providerConfig,
    workingDir,
    permissions: agentConfig.permissions,
    abortController: abortController ?? new AbortController(),
    requestPermission: requestPermission ?? (() => Promise.resolve({ approved: true })),
    askUserQuestions,
    messages: [],
    // Born empty and dies with the session: a "read" from a previous
    // conversation is not evidence about this one, which is why
    // `resetMemorySession` (dropping this context) is enough to clear it.
    readFileState: createReadState(),
    getTodos: () => todos,
    setTodos: (t) => { todos = t; },
    getTasks: () => tasks,
    setTasks: (t) => { tasks = t; },
    // Either plan state makes the turn read-only: the one a tool entered, and
    // the one the UI is sitting in.
    getPlanMode: () => planMode || (isPlanMode.current?.() ?? false),
    setPlanMode: (m) => { planMode = m; },
    lastPermissionWaitMs: 0,
    recordPermissionWait: () => {},
    consumePermissionWaitMs: () => 0,
    onToolResult,
    onPermissionDenied,
    onToolOutput,
    onToolActivity,
    onTodosChange,
    onSystemMessage: opts.onSystemMessage,
  };
  const tools = toolsToBindingFormat(
    getTools(agentConfig.permissions, agentConfig.allowedTools),
    context,
  );

  
  const extraToolSets: StandardToolSet[] = [];
  if (opts.mcpServers) {
    for (const [name, srv] of Object.entries(opts.mcpServers)) {
      if (srv.enabled === false) continue;
      try {
        // Awaited, and before the connect rather than after: the point is to
        // be visible *while* the thread is blocked below, not to report once
        // it is over.
        if (opts.onMcpConnect) await opts.onMcpConnect(name);
        const configJson = JSON.stringify({
          // Required, and not sent to the server: it qualifies every tool the
          // server exposes as `mcp__<name>__<tool>`. That qualified name is
          // what the model is offered and what the gate below sees, so it is
          // also the name a permission rule has to key on.
          name,
          transport: srv.command ? "stdio" : "http",
          command: srv.command,
          args: srv.args,
          env: srv.env,
          url: (srv as any).url,
          headers: (srv as any).headers,
        });
        const ts = mcpToolsetFromServer(configJson);
        if (!ts) continue;
        // Every MCP tool is gated by the app's own permission pipeline — see
        // mcpPermissions.ts. Without an addon that can carry the approver the
        // gate would fail closed on every undecided call, which the user would
        // read as "this server is broken"; refuse the toolset instead and say
        // so once, plainly.
        if (!supportsApprover) {
          opts.onSystemMessage?.(
            `MCP server "${name}" was not attached: this build of ai-sdk-cpp cannot ` +
              `route MCP tool approvals through the permission prompt. Rebuild the SDK.`,
          );
          continue;
        }
        const gate = createMcpPermissionGate(context, name);
        extraToolSets.push(withPermissions(ts, gate.policy, gate.approver));
      } catch (err) {
        // A server that will not start must not vanish silently: the tools it
        // was supposed to provide are simply absent from the agent, and the
        // model has no way to find out why.
        opts.onSystemMessage?.(
          `MCP server "${name}" could not be attached: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  
  
  
  let gitBranch: string | null = null;
  try {
    const gr = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workingDir,
      encoding: "utf-8",
      timeout: 5000,
    });
    if (gr.status === 0) {
      const b = (gr.stdout || "").trim();
      gitBranch = b && b !== "HEAD" ? b : null;
    }
  } catch {
    
  }

  let instructions = assembleSystemPromptSync({
    identity: agentConfig.systemPrompt || "",
    cwd: workingDir,
    model: providerConfig.model,
    tools: getTools(agentConfig.permissions, agentConfig.allowedTools),
    gitBranch: gitBranch ?? undefined,
  });

  
  try {
    // Register custom output styles (.claude/output-styles) before composing
    // so getOutputStyle() can resolve them in the prompt.
    try {
      loadCustomOutputStylesSync(workingDir);
    } catch {  }
    instructions = composeWithSystemPrompt(instructions, outputStyle);
  } catch {

  }

  // Project + user memory, appended last so it reads as the most specific
  // instruction in the prompt. The list itself lives in services/memoryFiles.ts
  // so `/doctor` reports exactly the files this line reads.
  instructions = appendMemoryFiles(instructions, memoryFileCandidates(workingDir));

  
  
  const agent = new Agent({
    model,
    tools,
    instructions,
    maxSteps: agentConfig.maxSteps || 25,
    extraToolSets: extraToolSets.length > 0 ? extraToolSets : undefined,
    ...(providerOptions ? { providerOptions } : {}),
  });
  const session = new Session(agent, { memoryDir, maxContextTokens, enableCheckpoint: false });

  if (opts.history && opts.history.length > 0) {
    for (const msg of opts.history) {
      if (msg.role === "user") {
        session.addUser(msg.content);
      } else if (msg.role === "assistant") {
        session.addAssistant(msg.content);
      }
    }
  }

  const ms: MemorySession = { agent, session, context };
  cache.set(key, { key, ms, context, isPlanMode });
  trimCache(key);
  return ms;
}

/** Drop a session's cache entry (e.g. a finished subagent run) so its native
 *  objects can be collected once nothing references them. Safe to call with a
 *  session that isn't cached. */
export function releaseMemorySession(session: object): void {
  for (const [key, entry] of cache) {
    if (entry.ms.session === (session as MemorySession["session"])) {
      cache.delete(key);
      return;
    }
  }
}


export function resetMemorySession(): void {
  cache.clear();
}
