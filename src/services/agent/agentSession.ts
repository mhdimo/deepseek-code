// Persistent, memory-enabled C++ session for deepseek-code.
//
// The C++ Session owns conversation history + context management:
// MemoryContextStrategy auto-injects relevant persisted memory each turn, and
// the inner SlidingWindowStrategy auto-compacts near maxContextTokens. The
// session is created once per (provider, model, workingDir, agent, memoryDir)
// and reused across turns so the C++ retains history + memory. Call
// resetMemorySession() on /clear or provider switch.

import { Agent, Session, mcpToolsetFromServer, type StandardToolSet } from "ai-sdk-cpp";
import { createModel } from "../provider/registry.js";
import { getTools, toolsToBindingFormat } from "../../tools.js";
import type { ToolUseContext, PermissionCallback } from "../../Tool.js";
import type { AgentConfig, ProviderConfig, MCPServerConfig, TodoItem, TaskItem, Message } from "../../types/index.js";
import { readFileSync, existsSync } from "node:fs";

export interface MemorySession {
  agent: Agent;
  session: Session;
}

interface CacheEntry { key: string; ms: MemorySession; context: ToolUseContext; }
let cache: CacheEntry | null = null;

export function getOrCreateMemorySession(opts: {
  providerConfig: ProviderConfig;
  agentConfig: AgentConfig;
  workingDir: string;
  memoryDir: string;
  maxContextTokens?: number;
  requestPermission?: PermissionCallback;
  mcpServers?: Record<string, MCPServerConfig>;
  abortController?: AbortController;
  onToolResult?: (toolName: string, input: any, output: string, isError: boolean) => void;
  onToolOutput?: (toolName: string, text: string) => void;
  onTodosChange?: (todos: TodoItem[]) => void;
  history?: Message[];
}): MemorySession {
  const { providerConfig, agentConfig, workingDir, memoryDir, maxContextTokens, requestPermission, abortController, onToolResult, onToolOutput, onTodosChange } = opts;
  const key = [
    providerConfig.type, providerConfig.model || "", providerConfig.baseURL || "",
    workingDir, agentConfig.name, memoryDir,
  ].join("|");
  if (cache && cache.key === key) {
    if (requestPermission) {
      cache.context.requestPermission = requestPermission;
    }
    if (abortController) {
      cache.context.abortController = abortController;
    }
    if (onToolResult) {
      cache.context.onToolResult = onToolResult;
    }
    if (onToolOutput) {
      cache.context.onToolOutput = onToolOutput;
    }
    if (onTodosChange) {
      cache.context.onTodosChange = onTodosChange;
    }
    return cache.ms;
  }

  const model = createModel(providerConfig);

  // Per-session mutable state — persists across turns within this session
  // (resets on /clear or provider switch when the session is recreated).
  let todos: TodoItem[] = [];
  let tasks: TaskItem[] = [];
  let planMode = false;

  const context: ToolUseContext = {
    providerConfig,
    workingDir,
    permissions: agentConfig.permissions,
    abortController: abortController ?? new AbortController(),
    requestPermission: requestPermission ?? (() => Promise.resolve({ approved: true })),
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
  };
  const tools = toolsToBindingFormat(getTools(agentConfig.permissions), context);

  // Connect to configured MCP servers (best-effort; failures skip the server).
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
      } catch { /* skip failed server */ }
    }
  }

  // Auto-inject project context (CLAUDE.md / DEEP.md / AGENTS.md) into the prompt.
  let instructions = agentConfig.systemPrompt;
  for (const doc of ["CLAUDE.md", "DEEP.md", "AGENTS.md"]) {
    const docPath = `${workingDir}/${doc}`;
    if (existsSync(docPath)) {
      try {
        const content = readFileSync(docPath, "utf-8");
        if (content.trim()) {
          instructions += `\n\n--- ${doc} (project context) ---\n${content}`;
        }
      } catch { /* read error — skip */ }
    }
  }

  const agent = new Agent({
    model,
    tools,
    instructions,
    maxSteps: agentConfig.maxSteps || 25,
    extraToolSets: extraToolSets.length > 0 ? extraToolSets : undefined,
  });
  const session = new Session(agent, { memoryDir, maxContextTokens });

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
  cache = { key, ms, context };
  return ms;
}

/** Drop the cached session (e.g. on /clear or provider/model switch). */
export function resetMemorySession(): void {
  cache = null;
}
