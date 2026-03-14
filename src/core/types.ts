// Core types for z-code

import type { z } from "zod";

// ─── Provider ───────────────────────────────────────────────────────────────

/** Provider types — "openai" works for any OpenAI-compatible endpoint */
export type ProviderType = "openai" | "anthropic";

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
  output?: string;
  isExpanded?: boolean;
  status?: "running" | "done" | "error";
  duration?: number;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
  toolUse?: ToolUseBlock[];
  isError?: boolean;
  /** Extended thinking / reasoning text (collapsed by default) */
  thinking?: string;
}

// ─── Agent Events (streamed from agent → TUI) ──────────────────────────────

export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-call-result"; toolCallId: string; toolName: string; result: string; duration: number }
  | { type: "step-finish"; stepTokens: { prompt: number; completion: number } }
  | { type: "finish"; usage: TokenUsage; finishReason: string }
  | { type: "error"; error: string }
  | { type: "permission-request"; toolName: string; args: Record<string, unknown>; resolve: (approved: boolean) => void };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

// ─── Agent ──────────────────────────────────────────────────────────────────

export type AgentName = "code" | "plan" | "review";

/** Thinking depth for extended reasoning (Anthropic-compatible models only) */
export type ThinkingMode = "off" | "light" | "deep" | "max";

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

export interface ZCodeConfig {
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
