// Core types for DeepSeek Code

// ─── Provider ───────────────────────────────────────────────────────────────

/** Provider types — DeepSeek uses OpenAI-compatible API */
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

// ─── Messages ───────────────────────────────────────────────────────────────

export interface ToolUseBlock {
  toolName: string;
  toolCallId?: string;
  input?: string;
  argsJson?: string;
  output?: string;
  isExpanded?: boolean;
  status?: "running" | "done" | "error";
  duration?: number;
}

export interface MessageBlock {
  type: "text" | "tool";
  content?: string;
  block?: ToolUseBlock;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
  toolUse?: ToolUseBlock[];
  isError?: boolean;
  /** Extended thinking / reasoning text (collapsed by default) */
  thinking?: string;
  /** Chronological list of text/tool blocks to prevent layout swapping */
  blocks?: MessageBlock[];
}

// ─── Agent Events (streamed from agent → TUI) ──────────────────────────────

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

// ─── Query Events (from QueryEngine → TUI) ──────────────────────────────────

/** Cost estimate for a single query step */
export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

/** Token budget configuration */
export interface TokenBudget {
  maxContextTokens: number;  // e.g. 64k for deepseek-chat
  compactionThreshold: number; // 0.0–1.0, compact when usage exceeds this fraction
  reservedForResponse: number; // tokens reserved for the model's response
}

export type QueryEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-call-delta"; toolCallId: string; toolName: string; text: string }
  | { type: "tool-call-end"; toolCallId: string; toolName: string }
  | { type: "tool-call-result"; toolCallId: string; toolName: string; result: string; duration: number }
  | { type: "step-finish"; stepTokens: { prompt: number; completion: number } }
  | { type: "token-usage"; usage: TokenUsage; cost: CostEstimate }
  | { type: "compact"; reason: string; messagesBefore: number; messagesAfter: number }
  | { type: "finish"; usage: TokenUsage; cost: CostEstimate; finishReason: string }
  | { type: "error"; error: string };

// ─── Tools ──────────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

// ─── Agent ──────────────────────────────────────────────────────────────────

export type AgentName = "code" | "plan" | "review";

/** Thinking mode - whalethink enables extended reasoning with blue glow effect */
export type ThinkingMode = "off" | "whale";

export interface AgentConfig {
  name: AgentName;
  displayName: string;
  description: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  permissions: PermissionRuleset;
}

export interface PermissionRuleset {
  allowRead: boolean;
  allowWrite: boolean;
  allowExecute: boolean;
  allowNetwork: boolean;
}

// ─── Session ────────────────────────────────────────────────────────────────

export interface SessionState {
  messages: Message[];
  currentAgent: AgentName;
  provider: ProviderConfig;
  workingDirectory: string;
  tokenUsage: TokenUsage;
  cost: number;
}

// ─── Model Profiles ─────────────────────────────────────────────────────────

/** A named model profile with its own provider, key, and endpoint */
export interface ModelProfile {
  provider: ProviderType;
  model: string;
  apiKey: string;
  baseURL?: string;
  displayName?: string;
}

// ─── MCP Servers ────────────────────────────────────────────────────────────

/**
 * Minimal MCP server config (compatible with common MCP JSON patterns).
 * This is used for discovery and runtime toggling in the TUI.
 */
export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface DeepSeekCodeConfig {
  provider: ProviderType;
  model: string;
  apiKey: string;
  baseURL?: string;
  maxSteps?: number;
  defaultAgent?: AgentName;
  dangerouslySkipPermissions?: boolean;
  /** Named model profiles for quick /model switching */
  profiles?: Record<string, ModelProfile>;
  /** Optional MCP server definitions loaded from config file */
  mcpServers?: Record<string, MCPServerConfig>;
}

/** @deprecated Use DeepSeekCodeConfig */
export type ZCodeConfig = DeepSeekCodeConfig;

// ─── Task & Todo management ─────────────────────────────────────────────────

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
