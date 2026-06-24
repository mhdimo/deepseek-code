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
import type { AgentConfig, ProviderConfig, MCPServerConfig } from "../../types/index.js";

export interface MemorySession {
  agent: Agent;
  session: Session;
}

interface CacheEntry { key: string; ms: MemorySession; }
let cache: CacheEntry | null = null;

export function getOrCreateMemorySession(opts: {
  providerConfig: ProviderConfig;
  agentConfig: AgentConfig;
  workingDir: string;
  memoryDir: string;
  maxContextTokens?: number;
  requestPermission?: PermissionCallback;
  mcpServers?: Record<string, MCPServerConfig>;
}): MemorySession {
  const { providerConfig, agentConfig, workingDir, memoryDir, maxContextTokens, requestPermission } = opts;
  const key = [
    providerConfig.type, providerConfig.model || "", providerConfig.baseURL || "",
    workingDir, agentConfig.name, memoryDir,
  ].join("|");
  if (cache && cache.key === key) return cache.ms;

  const model = createModel(providerConfig);

  // Per-session tool context. Shared mutable state (todos/tasks/planMode) is
  // stubbed for now; wiring real App state through is a follow-up.
  const context: ToolUseContext = {
    workingDir,
    permissions: agentConfig.permissions,
    abortController: new AbortController(),
    requestPermission: requestPermission ?? (() => Promise.resolve({ approved: true })),
    messages: [],
    getTodos: () => [],
    setTodos: () => {},
    getTasks: () => [],
    setTasks: () => {},
    getPlanMode: () => false,
    setPlanMode: () => {},
    lastPermissionWaitMs: 0,
    recordPermissionWait: () => {},
    consumePermissionWaitMs: () => 0,
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

  const agent = new Agent({
    model,
    tools,
    instructions: agentConfig.systemPrompt,
    maxSteps: agentConfig.maxSteps || 25,
    extraToolSets: extraToolSets.length > 0 ? extraToolSets : undefined,
  });
  const session = new Session(agent, { memoryDir, maxContextTokens });

  const ms: MemorySession = { agent, session };
  cache = { key, ms };
  return ms;
}

/** Drop the cached session (e.g. on /clear or provider/model switch). */
export function resetMemorySession(): void {
  cache = null;
}
