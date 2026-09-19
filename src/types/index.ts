




export type ProviderType = "deepseek";

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseURL?: string;
  model?: string;
}

export interface ProviderOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}



export interface ToolUseBlock {
  toolName: string;
  toolCallId?: string;
  input?: string;
  argsJson?: string;
  output?: string;
  isExpanded?: boolean;
  status?: "running" | "done" | "error" | "rejected" | "interrupted";
  duration?: number;
}

export interface MessageBlock {
  type: "text" | "tool" | "thinking";
  content?: string;
  block?: ToolUseBlock;
  /** Thinking block lifecycle timestamps (ms since epoch), for the
   *  elapsed-time label. Set by App on thinking-start / thinking-end. */
  thinkingStart?: number;
  thinkingEnd?: number;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
  toolUse?: ToolUseBlock[];
  isError?: boolean;

  thinking?: string;

  blocks?: MessageBlock[];
  /**
   * Set on the message that replaced a transcript at a /compact boundary.
   * It replays into the native session as a user turn (the model must read it
   * as context it was given), but it is not something the user typed, and the
   * UI says so.
   */
  compaction?: {
    /** How many messages were folded into this summary. */
    summarized: number;
    /** Where the pre-compaction transcript was written, if it was. */
    archivedTo?: string;
  };
}



export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-call-result"; toolCallId: string; toolName: string; result: string; duration: number }
  | { type: "step-finish"; stepTokens: { prompt: number; completion: number } }
  | { type: "finish"; usage: TokenUsage; cost?: CostEstimate; finishReason: string }
  | { type: "error"; error: string }
  | { type: "permission-request"; toolName: string; args: Record<string, unknown>; resolve: (approved: boolean) => void };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}




export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}


export interface TokenBudget {
  maxContextTokens: number;  
  compactionThreshold: number; 
  reservedForResponse: number; 
}

export type QueryEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-end" }
  | { type: "tool-call-start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-call-delta"; toolCallId: string; toolName: string; text: string }
  | { type: "tool-call-end"; toolCallId: string; toolName: string }
  | { type: "tool-call-result"; toolCallId: string; toolName: string; result: string; duration: number }
  | { type: "step-finish"; stepTokens: { prompt: number; completion: number } }
  /** Not yet emitted: the engine reports usage on `finish` and has no
   *  separate usage event. Kept as the shape it would take. */
  | { type: "token-usage"; usage: TokenUsage; cost: CostEstimate }
  /** Not yet emitted: the engine compacts inside the native session and
   *  reports nothing when it does — no StreamEvent member exists for it yet,
   *  so an eviction is currently visible only as prompt tokens shrinking.
   *  Requirement filed against ai-sdk-cpp. */
  | { type: "compact"; reason: string; messagesBefore: number; messagesAfter: number }
  | { type: "finish"; usage: TokenUsage; cost: CostEstimate; finishReason: string }
  | { type: "error"; error: string };



export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}



export type AgentName = "code" | "plan" | "review";

/** Agent color names (Claude Code agentColorManager parity). */
export type AgentColorName =
  | "red" | "blue" | "green" | "yellow"
  | "purple" | "orange" | "pink" | "cyan";

/** A named team of agents with per-teammate colors, persisted in settings. */
export interface TeamConfig {
  name: string;
  description?: string;
  teammates: string[];
  colors: Record<string, AgentColorName>;
}


export type ThinkingMode = "off" | "whale";

export interface AgentConfig {
  /** Built-in name or a discovered custom-agent name (`.claude/agents/*.md`). */
  name: AgentName | (string & {});
  displayName: string;
  description: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  permissions: PermissionRuleset;
  /**
   * The exact tool names this agent asked for — `.claude/agents/*.md`
   * frontmatter `tools:`. Narrows the pool to those names (intersected with
   * the grants above) so an agent that listed `Read, Grep` does not also get
   * every other tool its grants would allow. Absent means "no name filter":
   * built-in agents, and definitions that omitted `tools:`, get the whole
   * pool their grants admit.
   */
  allowedTools?: readonly string[];
}

export interface PermissionRuleset {
  allowRead: boolean;
  allowWrite: boolean;
  allowExecute: boolean;
  allowNetwork: boolean;
}



export interface SessionState {
  messages: Message[];
  currentAgent: AgentName;
  provider: ProviderConfig;
  workingDirectory: string;
  tokenUsage: TokenUsage;
  cost: number;
}




export interface ModelProfile {
  provider: ProviderType;
  model: string;
  apiKey: string;
  baseURL?: string;
  displayName?: string;
}




export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}



/**
 * Permission rules as they are stored: in `~/.deepseek-code/settings.json` for
 * the user's own scope, and in a workspace's `.deepseek-code.json` for the
 * project's. `/permissions` writes both — the second one only for a trusted
 * workspace, which is also the only state in which it is read.
 */
export interface ConfigPermissionRules {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

export interface DeepSeekCodeConfig {
  provider: ProviderType;
  model: string;
  apiKey: string;
  baseURL?: string;
  maxSteps?: number;
  defaultAgent?: AgentName;
  dangerouslySkipPermissions?: boolean;

  profiles?: Record<string, ModelProfile>;

  mcpServers?: Record<string, MCPServerConfig>;

  permissions?: ConfigPermissionRules;
}


export type ZCodeConfig = DeepSeekCodeConfig;



export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
}
