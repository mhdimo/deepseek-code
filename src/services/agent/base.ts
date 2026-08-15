






import { type Model as BindingModel } from "ai-sdk-cpp";
import { getOrCreateMemorySession, releaseMemorySession } from "./agentSession.js";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentEvent, Message, ProviderConfig } from "../../types/index.js";
import { createModel } from "../provider/registry.js";
import type { PermissionCallback } from "../../Tool.js";



type ErrorCategory = "auth" | "rate-limit" | "network" | "server" | "timeout" | "unknown";

function categorizeError(error: unknown): { category: ErrorCategory; message: string; retryable: boolean } {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes("401") || lower.includes("invalid api key") || lower.includes("authentication")) {
    return { category: "auth", message: `Authentication error: ${msg}`, retryable: false };
  }
  if (lower.includes("402") || lower.includes("insufficient balance")) {
    return { category: "auth", message: `Insufficient balance: ${msg}`, retryable: false };
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { category: "rate-limit", message: `Rate limited`, retryable: true };
  }
  if (lower.includes("500") || lower.includes("server error")) {
    return { category: "server", message: `Server error`, retryable: true };
  }
  if (lower.includes("503") || lower.includes("overloaded")) {
    return { category: "server", message: `Server overloaded`, retryable: true };
  }
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("etimedout") || lower.includes("network") || lower.includes("fetch failed")) {
    return { category: "network", message: `Network error`, retryable: true };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { category: "timeout", message: `Timeout: ${msg}`, retryable: false };
  }

  return { category: "unknown", message: msg, retryable: false };
}

export class Agent {
  private model: BindingModel;
  private config: AgentConfig;
  private providerConfig: ProviderConfig;
  private abortController: AbortController | null = null;

  constructor(config: AgentConfig, providerConfig: ProviderConfig) {
    this.config = config;
    this.providerConfig = providerConfig;
    this.model = createModel(providerConfig);
  }

  get name() { return this.config.name; }
  get displayName() { return this.config.displayName; }
  get description() { return this.config.description; }
  get permissions() { return this.config.permissions; }

  abort(): void {
    this.abortController?.abort();
  }


  async *run(
    userMessage: string,
    history: Message[],
    workingDir: string,
    requestPermission?: PermissionCallback,
  ): AsyncGenerator<AgentEvent> {
    const runAbortController = new AbortController();
    this.abortController = runAbortController;

    // Drive the native Agent + Session loop through the SAME construction the
    // main chat uses (getOrCreateMemorySession) so the C++ side owns tool
    // execution, retries, and step limits. A unique sessionKey gives each
    // subagent run its own session (concurrent-safe); the throwaway memoryDir
    // keeps subagent memory isolated from the main session's. Direct
    // Agent/Session construction here crashed the native tool callback, while
    // this exact path is stable — reuse it rather than mirror it.
    const subagentMemoryDir = join(tmpdir(), "dsc-subagents", randomUUID());
    try {
      mkdirSync(subagentMemoryDir, { recursive: true });
    } catch {
      // best-effort — an unwritable dir only skips memory features
    }

    const ms = getOrCreateMemorySession({
      providerConfig: this.providerConfig,
      agentConfig: this.config,
      workingDir,
      memoryDir: subagentMemoryDir,
      requestPermission: requestPermission ?? undefined,
      abortController: runAbortController,
      history: history.slice(-30),
      sessionKey: `subagent-${randomUUID().slice(0, 8)}`,
    });
    // Hold the whole MemorySession (not just .session): the JS Agent wrapper
    // owns the native ToolSet — dropping it mid-run lets GC free the toolset
    // under the native loop's feet (SIGTRAP). Released in the finally below.
    const session = ms.session;


    const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      for await (const ev of session.sendStream(userMessage)) {
        if (runAbortController.signal.aborted) break;
        switch (ev.type) {
          case "text_delta":
            yield { type: "text-delta", text: ev.text || "" };
            break;
          case "reasoning_delta":
            yield { type: "thinking-delta", text: ev.text || "" };
            break;
          case "tool_call_start":
            yield {
              type: "tool-call-start",
              toolCallId: ev.toolCallId || "",
              toolName: ev.toolName || "",
              args: {},
            };
            break;
          case "tool_result":
            yield {
              type: "tool-call-result",
              toolCallId: ev.toolCallId || "",
              toolName: ev.toolName || "",
              result: ev.text || "",
              duration: 0,
            };
            break;
          case "finish": {
            const u = ev.usage
              ? { promptTokens: ev.usage.inputTokens, completionTokens: ev.usage.outputTokens, totalTokens: ev.usage.inputTokens + ev.usage.outputTokens }
              : totalUsage;
            yield { type: "finish", usage: u, finishReason: "stop" };
            break;
          }
          case "error":
            yield { type: "error", error: ev.text || "stream error" };
            return;
        }
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        yield { type: "error", error: "Generation interrupted." };
      } else {
        const categorized = categorizeError(error);
        yield { type: "error", error: categorized.message };
      }
    } finally {
      if (this.abortController === runAbortController) {
        this.abortController = null;
      }
      // The run is done — drop the cache entry so this subagent's native
      // session can be collected (ms stays referenced by this frame's scope
      // until the generator is closed, covering late tool callbacks).
      releaseMemorySession(session);
    }
  }
}
