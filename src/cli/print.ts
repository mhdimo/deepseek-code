

























import { getOrCreateMemorySession } from "../services/agent/agentSession.js";
import { agentManager } from "../services/agent/index.js";
import type { StreamEvent } from "ai-sdk-cpp";
import { homedir } from "node:os";
import type { AgentConfig, ProviderConfig, Message, MCPServerConfig } from "../types/index.js";
import { existsSync, readFileSync } from "node:fs";



export interface PrintOptions {
  
  prompt: string;
  
  model?: string;
  
  systemOverride?: string;
  
  systemPromptFile?: string;
  
  outputFormat?: "text" | "json";
  
  maxTurns?: number;
  
  workingDir?: string;
  
  memoryDir?: string;
  
  maxContextTokens?: number;
  
  providerConfig: ProviderConfig;
  
  agent?: "code" | "plan" | "review";
  
  history?: Message[];
  
  mcpServers?: Record<string, MCPServerConfig>;
  
  verbose?: boolean;
  
  streamText?: boolean;
}



export interface PrintResult {
  text: string;
  
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    result: string;
    isError: boolean;
    durationMs: number;
  }>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: string;
  
  durationMs: number;
}




export async function runPrint(opts: PrintOptions): Promise<PrintResult> {
  const {
    prompt,
    model,
    outputFormat = "text",
    maxTurns,
    workingDir = process.cwd(),
    memoryDir,
    maxContextTokens,
    providerConfig,
    agent = "code",
    history,
    mcpServers,
    verbose = false,
    streamText = outputFormat === "text",
  } = opts;

  
  const agentConfig = cloneAgentConfig(agentManager.getConfig(agent), {
    maxSteps: maxTurns,
    systemPrompt: resolveSystemPrompt(opts),
  });

  const providerCfg: ProviderConfig = model
    ? { ...providerConfig, model }
    : providerConfig;

  
  
  const autoApprove = async () => ({ approved: true });

  const { session } = getOrCreateMemorySession({
    providerConfig: providerCfg,
    agentConfig,
    workingDir,
    memoryDir: memoryDir ?? `${homedirSafe()}/.deepseek-code/memory`,
    maxContextTokens,
    requestPermission: autoApprove,
    mcpServers,
    history,
    abortController: new AbortController(),
    onToolResult: (toolName, input, output, isError) => {
      if (verbose) {
        
        
        const preview = truncate(output, 200);
        process.stderr.write(
          `\r[K[tool] ${toolName}${isError ? " (error)" : ""}: ${preview}\n`,
        );
      }
    },
  });

  const startedAt = Date.now();
  const textParts: string[] = [];
  const toolCalls: PrintResult["toolCalls"] = [];
  
  const inflight = new Map<string, { name: string; input: Record<string, unknown>; startedAt: number }>();

  let usage: PrintResult["usage"] = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  let finishReason = "stop";
  let streamError: string | null = null;

  try {
    for await (const ev of session.sendStream(prompt) as AsyncGenerator<StreamEvent>) {
      switch (ev.type) {
        case "text_delta": {
          const chunk = ev.text || "";
          textParts.push(chunk);
          if (streamText) {
            process.stdout.write(chunk);
          }
          break;
        }
        case "tool_call_start": {
          const id = ev.toolCallId || syntheticId();
          inflight.set(id, {
            name: ev.toolName || "(unknown)",
            input: {},
            startedAt: Date.now(),
          });
          if (verbose) {
            process.stderr.write(`\r[K[tool] start ${ev.toolName || "?"}\n`);
          }
          break;
        }
        case "tool_call_delta": {
          
          
          
          break;
        }
        case "tool_call_end": {
          
          break;
        }
        case "tool_result": {
          const id = ev.toolCallId || "";
          const entry = inflight.get(id);
          if (entry) {
            toolCalls.push({
              name: entry.name,
              input: entry.input,
              result: ev.text || "",
              isError: false,
              durationMs: Date.now() - entry.startedAt,
            });
            inflight.delete(id);
          } else {
            
            toolCalls.push({
              name: ev.toolName || "(unknown)",
              input: {},
              result: ev.text || "",
              isError: false,
              durationMs: 0,
            });
          }
          break;
        }
        case "finish": {
          if (ev.usage) {
            usage = {
              promptTokens: ev.usage.inputTokens,
              completionTokens: ev.usage.outputTokens,
              totalTokens: ev.usage.inputTokens + ev.usage.outputTokens,
            };
          }
          break;
        }
        case "error": {
          streamError = ev.text || "stream error";
          break;
        }
        
        
        default:
          break;
      }
    }
  } catch (err) {
    streamError = (err as Error).message || String(err);
  }

  
  for (const [, entry] of inflight) {
    toolCalls.push({
      name: entry.name,
      input: entry.input,
      result: "",
      isError: true,
      durationMs: Date.now() - entry.startedAt,
    });
  }

  const text = textParts.join("").trimEnd();
  const durationMs = Date.now() - startedAt;

  if (streamError) {
    
    
    if (outputFormat === "json") {
      const result: PrintResult = {
        text,
        toolCalls,
        usage,
        finishReason: "error",
        durationMs,
      };
      process.stdout.write(JSON.stringify({ ...result, error: streamError }) + "\n");
      throw new Error(streamError);
    }
    process.stderr.write(`\nError: ${streamError}\n`);
    throw new Error(streamError);
  }

  const result: PrintResult = {
    text,
    toolCalls,
    usage,
    finishReason,
    durationMs,
  };

  if (outputFormat === "json") {
    
    
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (!streamText) {
    
    if (text) process.stdout.write(text + "\n");
  } else {
    
    process.stdout.write("\n");
  }

  return result;
}




function cloneAgentConfig(
  base: AgentConfig,
  overrides: { maxSteps?: number; systemPrompt?: string },
): AgentConfig {
  return {
    ...base,
    permissions: { ...base.permissions },
    maxSteps: overrides.maxSteps ?? base.maxSteps,
    systemPrompt: overrides.systemPrompt ?? base.systemPrompt,
  };
}


function resolveSystemPrompt(opts: PrintOptions): string | undefined {
  if (opts.systemOverride !== undefined) return opts.systemOverride;
  if (opts.systemPromptFile) {
    if (!existsSync(opts.systemPromptFile)) {
      throw new Error(`System prompt file not found: ${opts.systemPromptFile}`);
    }
    return readFileSync(opts.systemPromptFile, "utf-8");
  }
  return undefined; 
}

let _idCounter = 0;
function syntheticId(): string {
  _idCounter += 1;
  return `synthetic-${_idCounter}`;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}


function homedirSafe(): string {
  try {
    return homedir();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || "/tmp";
  }
}
