








import { Agent, Session, mcpToolsetFromServer, type StandardToolSet } from "ai-sdk-cpp";
import { createModel } from "../provider/registry.js";
import { getTools, toolsToBindingFormat } from "../../tools.js";
import type { AskUserQuestionsCallback, ToolUseContext, PermissionCallback } from "../../Tool.js";
import type { AgentConfig, ProviderConfig, MCPServerConfig, TodoItem, TaskItem, Message } from "../../types/index.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { assembleSystemPromptSync } from "../../constants/prompts.js";
import { composeWithSystemPrompt, loadCustomOutputStylesSync } from "../../services/outputStyles.js";
import { loadSettings } from "../../state/storage.js";
import { getEffortLevel, effortToProviderOptions } from "../effort.js";

export interface MemorySession {
  agent: Agent;
  session: Session;
}

interface CacheEntry { key: string; ms: MemorySession; context: ToolUseContext; }
// Multi-entry cache keyed by the session key string. The previous single-entry
// cache evicted the MAIN session whenever a subagent created its own session —
// the JS Agent wrapper (which owns the native ToolSet) then lost its last
// reference, GC ran its destructor mid-turn, and the native loop SIGTRAPped on
// the freed toolset. Entries stay referenced until explicitly released.
const cache = new Map<string, CacheEntry>();

export function getOrCreateMemorySession(opts: {
  providerConfig: ProviderConfig;
  agentConfig: AgentConfig;
  workingDir: string;
  memoryDir: string;
  maxContextTokens?: number;
  requestPermission?: PermissionCallback;
  askUserQuestions?: AskUserQuestionsCallback;
  mcpServers?: Record<string, MCPServerConfig>;
  abortController?: AbortController;
  onToolResult?: (toolName: string, input: any, output: string, isError: boolean) => void;
  onToolOutput?: (toolName: string, text: string) => void;
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
}): MemorySession {
  const { providerConfig, agentConfig, workingDir, memoryDir, maxContextTokens, requestPermission, askUserQuestions, abortController, onToolResult, onToolOutput, onTodosChange } = opts;



  const effort = (opts.effortOverride as ReturnType<typeof getEffortLevel> | undefined) ?? getEffortLevel();
  const providerOptions = effortToProviderOptions(effort);

  const key = [
    providerConfig.type, providerConfig.model || "", providerConfig.baseURL || "",
    workingDir, agentConfig.name, memoryDir,
    effort || "off",
    opts.sessionKey ?? "",
  ].join("|");
  const cached = cache.get(key);
  if (cached) {
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
    if (onToolOutput) {
      cached.context.onToolOutput = onToolOutput;
    }
    if (onTodosChange) {
      cached.context.onTodosChange = onTodosChange;
    }
    if (opts.onSystemMessage) {
      cached.context.onSystemMessage = opts.onSystemMessage;
    }
    return cached.ms;
  }

  const model = createModel(providerConfig);

  
  
  let todos: TodoItem[] = [];
  let tasks: TaskItem[] = [];
  let planMode = false;

  const context: ToolUseContext = {
    providerConfig,
    workingDir,
    permissions: agentConfig.permissions,
    abortController: abortController ?? new AbortController(),
    requestPermission: requestPermission ?? (() => Promise.resolve({ approved: true })),
    askUserQuestions,
    messages: [],
    getTodos: () => todos,
    setTodos: (t) => { todos = t; },
    getTasks: () => tasks,
    setTasks: (t) => { tasks = t; },
    getPlanMode: () => planMode,
    setPlanMode: (m) => { planMode = m; },
    lastPermissionWaitMs: 0,
    recordPermissionWait: () => {},
    consumePermissionWaitMs: () => 0,
    onToolResult,
    onToolOutput,
    onTodosChange,
    onSystemMessage: opts.onSystemMessage,
  };
  const tools = toolsToBindingFormat(getTools(agentConfig.permissions), context);

  
  const extraToolSets: StandardToolSet[] = [];
  if (opts.mcpServers) {
    for (const [, srv] of Object.entries(opts.mcpServers)) {
      if (srv.enabled === false) continue;
      try {
        const configJson = JSON.stringify({
          transport: srv.command ? "stdio" : "http",
          command: srv.command,
          args: srv.args,
          env: srv.env,
          url: (srv as any).url,
          headers: (srv as any).headers,
        });
        const ts = mcpToolsetFromServer(configJson);
        if (ts) extraToolSets.push(ts);
      } catch {  }
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
    tools: getTools(agentConfig.permissions),
    gitBranch: gitBranch ?? undefined,
  });

  
  try {
    // Register custom output styles (.claude/output-styles) before composing
    // so getOutputStyle() can resolve them in the prompt.
    try {
      loadCustomOutputStylesSync(workingDir);
    } catch {  }
    instructions = composeWithSystemPrompt(instructions, loadSettings().outputStyle);
  } catch {

  }

  
  for (const doc of ["CLAUDE.md", "DEEP.md", "AGENTS.md"]) {
    const docPath = `${workingDir}/${doc}`;
    if (existsSync(docPath)) {
      try {
        const content = readFileSync(docPath, "utf-8");
        if (content.trim()) {
          instructions += `\n\n--- ${doc} (project context) ---\n${content}`;
        }
      } catch {  }
    }
  }

  // User-level memory (~/.deepseek-code/CLAUDE.md), loaded after project docs.
  const userMemoryPath = `${homedir()}/.deepseek-code/CLAUDE.md`;
  if (existsSync(userMemoryPath)) {
    try {
      const content = readFileSync(userMemoryPath, "utf-8");
      if (content.trim()) {
        instructions += `\n\n--- CLAUDE.md (user memory) ---\n${content}`;
      }
    } catch {  }
  }

  
  
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

  const ms: MemorySession = { agent, session };
  cache.set(key, { key, ms, context });
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
