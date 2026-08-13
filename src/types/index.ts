




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
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
  toolUse?: ToolUseBlock[];
  isError?: boolean;
  
  thinking?: string;
  
  blocks?: MessageBlock[];
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
  | { type: "token-usage"; usage: TokenUsage; cost: CostEstimate }
  | { type: "compact"; reason: string; messagesBefore: number; messagesAfter: number }
  | { type: "finish"; usage: TokenUsage; cost: CostEstimate; finishReason: string }
  | { type: "error"; error: string };



export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}



export type AgentName = "code" | "plan" | "review";


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
