// Main App component — real agent integration with streaming
//
// This wires together:
//   - Agent system (code/plan/review agents with tool calling)
//   - Streaming display (text + tool blocks in real-time)
//   - Permission prompts (approve/deny tool execution)
//   - Slash commands (/help, /agent, /clear, /model, /compact, /cost)
//   - Token tracking and cost estimation

import React, { useState, useCallback, useRef } from "react";
import { Box, useApp, useInput } from "ink";
import ChatPanel from "./ChatPanel.js";
import StatusBar from "./StatusBar.js";
import TextInput from "./TextInput.js";
import PermissionPrompt from "./PermissionPrompt.js";
import { agentManager, Agent } from "../agent/index.js";
import { MODEL_PRESETS, resolvePresetApiKey, estimateCost } from "../provider/registry.ts";
import { getToolDescriptions } from "../tool/index.ts";
import type {
  Message,
  ToolUseBlock,
  AgentEvent,
  AgentName,
  ProviderConfig,
  ProviderType,
  ZCodeConfig,
} from "../core/types.js";

interface AppProps {
  config: ZCodeConfig;
  workingDirectory: string;
}

export default function App({ config, workingDirectory }: AppProps) {
  const { exit } = useApp();

  // ── State ─────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingToolUse, setStreamingToolUse] = useState<ToolUseBlock[]>([]);
  const [currentAgent, setCurrentAgent] = useState<AgentName>(config.defaultAgent || "code");
  const [tokenCount, setTokenCount] = useState(0);
  const [cost, setCost] = useState(0);
  const [pendingPermission, setPendingPermission] = useState<{
    toolName: string;
    description: string;
    resolve: (approved: boolean) => void;
  } | null>(null);

  // ── Runtime-mutable provider state ────────────────────────────────────
  const [activeProvider, setActiveProvider] = useState<ProviderType>(config.provider);
  const [activeModel, setActiveModel] = useState(config.model);
  const [activeApiKey, setActiveApiKey] = useState(config.apiKey);
  const [activeBaseURL, setActiveBaseURL] = useState(config.baseURL);

  // ── Thinking / extended reasoning ─────────────────────────────────────
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [streamingThinking, setStreamingThinking] = useState("");

  const agentRef = useRef<Agent | null>(null);

  // Helper: yield to the event loop so React/Ink can render between tokens
  const yieldToRenderer = () => new Promise<void>((r) => setTimeout(r, 0));

  // Derived — always reflects current mutable state
  const providerConfig: ProviderConfig = {
    type: activeProvider,
    apiKey: activeApiKey,
    baseURL: activeBaseURL,
    model: activeModel,
  };

  // Helper: switch to a named profile, preset, or custom model
  const switchModel = useCallback(
    (name: string): string | null => {
      // 1) Check user-defined profiles from config file
      const profile = config.profiles?.[name];
      if (profile) {
        setActiveProvider(profile.provider);
        setActiveModel(profile.model);
        setActiveApiKey(profile.apiKey);
        setActiveBaseURL(profile.baseURL);
        return `Switched to profile "${name}" → ${profile.provider}/${profile.model}${profile.baseURL ? ` (${profile.baseURL})` : ""}`;
      }

      // 2) Check built-in presets
      const preset = MODEL_PRESETS[name];
      if (preset) {
        const key = resolvePresetApiKey(preset, activeApiKey);
        const modelId = preset.model ?? name;
        setActiveProvider(preset.type);
        setActiveModel(modelId);
        setActiveBaseURL(preset.baseURL);
        if (key) setActiveApiKey(key);
        const keyStatus = key ? "✓ key found" : "⚠ no key — use /apikey <key>";
        return `Switched to ${name} → ${preset.type}/${modelId}${preset.baseURL ? ` (${preset.baseURL})` : ""} [${keyStatus}]`;
      }

      return null; // not found
    },
    [config.profiles, activeApiKey],
  );

  // ── Keybindings ───────────────────────────────────────────────────────
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      agentRef.current?.abort();
      exit();
    }
    if (key.escape && isLoading) {
      agentRef.current?.abort();
      setIsLoading(false);
      setStreamingText("");
      setStreamingThinking("");
      setStreamingToolUse([]);
      setMessages((prev) => [
        ...prev,
        { role: "system", content: "⚠ Generation interrupted.", timestamp: Date.now() },
      ]);
    }
    // Shift+Tab toggles thinking mode
    if (key.shift && key.tab && !isLoading) {
      setThinkingEnabled((prev) => !prev);
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: thinkingEnabled
            ? "💭 Extended thinking disabled."
            : "💭 Extended thinking enabled. Use \"think\", \"think hard\", or \"ultrathink\" in your prompt to control depth.",
          timestamp: Date.now(),
        },
      ]);
    }
  });

  // ── Permission callback ───────────────────────────────────────────────
  const requestPermission = useCallback(
    (toolName: string, description: string): Promise<boolean> => {
      if (config.dangerouslySkipPermissions) return Promise.resolve(true);
      return new Promise((resolve) => {
        setPendingPermission({ toolName, description, resolve });
      });
    },
    [config.dangerouslySkipPermissions],
  );

  // ── Process agent events ──────────────────────────────────────────────
  const processAgentStream = useCallback(
    async (events: AsyncGenerator<AgentEvent>) => {
      let text = "";
      let thinking = "";
      let toolUse: ToolUseBlock[] = [];

      for await (const event of events) {
        switch (event.type) {
          case "thinking-delta":
            thinking += event.text;
            setStreamingThinking(thinking);
            await yieldToRenderer();
            break;

          case "text-delta":
            text += event.text;
            setStreamingText(text);
            // Break the microtask chain so React/Ink renders this token
            // before processing the next one
            await yieldToRenderer();
            break;

          case "tool-call-start": {
            const block: ToolUseBlock = {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: formatToolInput(event.toolName, event.args),
              status: "running",
            };
            toolUse = [...toolUse, block];
            setStreamingToolUse(toolUse);
            break;
          }

          case "tool-call-result": {
            toolUse = toolUse.map((t) =>
              t.toolCallId === event.toolCallId
                ? {
                    ...t,
                    output: event.result,
                    status: event.result.startsWith("❌") ? "error" as const : "done" as const,
                    duration: event.duration,
                    isExpanded: event.result.startsWith("❌"),
                  }
                : t,
            );
            setStreamingToolUse(toolUse);
            // Reset streaming text for next step
            text = "";
            thinking = "";
            setStreamingText("");
            setStreamingThinking("");
            break;
          }

          case "step-finish":
            break;

          case "finish":
            setTokenCount((prev) => prev + event.usage.totalTokens);
            setCost((prev) => prev + estimateCost(activeModel, {
              promptTokens: event.usage.promptTokens,
              completionTokens: event.usage.completionTokens,
            }));
            break;

          case "error": {
            // Finalize as error message
            const errorMsg: Message = {
              role: "assistant",
              content: event.error,
              timestamp: Date.now(),
              toolUse: toolUse.length > 0 ? toolUse : undefined,
              thinking: thinking || undefined,
              isError: true,
            };
            setMessages((prev) => [...prev, errorMsg]);
            setStreamingText("");
            setStreamingThinking("");
            setStreamingToolUse([]);
            setIsLoading(false);
            return;
          }
        }
      }

      // Finalize the assistant message
      if (text || toolUse.length > 0 || thinking) {
        const finalMessage: Message = {
          role: "assistant",
          content: text,
          timestamp: Date.now(),
          toolUse: toolUse.length > 0 ? toolUse : undefined,
          thinking: thinking || undefined,
        };
        setMessages((prev) => [...prev, finalMessage]);
      }
      setStreamingText("");
      setStreamingThinking("");
      setStreamingToolUse([]);
      setIsLoading(false);
    },
    [activeModel],
  );

  // ── Slash commands ────────────────────────────────────────────────────
  const handleCommand = useCallback(
    (cmd: string): boolean => {
      const parts = cmd.trim().split(/\s+/);
      const command = parts[0]!.toLowerCase();
      const arg = parts[1];
      const restArgs = parts.slice(1);

      switch (command) {
        case "/help": {
          const tools = getToolDescriptions();
          const agents = agentManager.listAgents();
          const profileNames = Object.keys(config.profiles || {});
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: [
                "━━━ Commands ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                "  /help                Show this help",
                "  /model               Show current model info",
                "  /model <name>        Switch to a preset or profile",
                "  /model set <provider> <model> [baseurl]",
                "                       Set a custom OpenAI-compatible model",
                "  /models              List available presets & profiles",
                "  /apikey <key>        Set the API key for current provider",
                "  /agent <name>        Switch agent (code, plan, review)",
                "  /clear               Clear conversation history",
                "  /compact             Summarize conversation to save context",
                "  /cost                Show token usage and cost",
                "  /tools               List available tools",
                "  /exit                Exit z-code",
                "",
                "━━━ Agents ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                ...agents.map(
                  (a) =>
                    `  ${a.name === currentAgent ? "▸" : " "} ${a.name.padEnd(8)} ${a.description}`,
                ),
                "",
                "━━━ Tools (" + currentAgent + " agent) ━━━━━━━━━━━━━━━━━━",
                ...tools.map((t) => `  ${t.name.padEnd(8)} ${t.description}`),
                ...(profileNames.length > 0
                  ? [
                      "",
                      "━━━ Your Profiles ━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                      ...profileNames.map((n) => {
                        const p = config.profiles![n]!;
                        return `  ${n.padEnd(16)} ${p.provider}/${p.model}`;
                      }),
                    ]
                  : []),
                "",
                "━━━ Keyboard ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                "  Shift+Tab          Toggle extended thinking",
                "  Ctrl+C             Exit",
                "  Esc                Interrupt generation",
                "",
                "━━━ Thinking ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                "  Include keywords in your prompt to control depth:",
                "  \"think\"            Light thinking (~10k tokens)",
                "  \"think hard\"       Deep thinking (~30k tokens)",
                "  \"megathink\"        Very deep (~60k tokens)",
                "  \"ultrathink\"       Maximum depth (~128k tokens)",
              ].join("\n"),
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        // ── /model ─────────────────────────────────────────────────────
        case "/model": {
          if (!arg) {
            // Show current model info
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: [
                  `Provider: ${activeProvider}`,
                  `Model:    ${activeModel}`,
                  `Base URL: ${activeBaseURL || "(default)"}`,
                  `API Key:  ${activeApiKey ? activeApiKey.slice(0, 8) + "…" + activeApiKey.slice(-4) : "(not set)"}`,
                  "",
                  "Quick switch:  /model <preset-name>",
                  "Custom model:  /model set <provider> <model> [baseurl]",
                  "Set API key:   /apikey <key>",
                ].join("\n"),
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          // /model set <provider> <model> [baseurl]
          if (arg === "set") {
            const provider = parts[2];
            const modelName = parts[3];

            if (!provider || !modelName) {
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content:
                    "Usage: /model set <provider> <model> [baseurl]\n\n" +
                    "Examples:\n" +
                    "  /model set openai gpt-4o\n" +
                    "  /model set openai glm-4 https://open.bigmodel.cn/api/v1\n" +
                    "  /model set anthropic claude-sonnet-4-20250514\n" +
                    "  /model set openai deepseek-chat https://api.deepseek.com/v1",
                  timestamp: Date.now(),
                },
              ]);
              return true;
            }

            const baseURL = parts[4];
            const provType = provider as ProviderType;
            setActiveProvider(provType);
            setActiveModel(modelName);
            if (baseURL) setActiveBaseURL(baseURL);
            else setActiveBaseURL(provType === "anthropic" ? undefined : undefined);

            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  `✓ Model set → ${provType}/${modelName}` +
                  (baseURL ? ` (${baseURL})` : "") +
                  (activeApiKey ? "" : "\n⚠ No API key set. Use /apikey <key>"),
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          // /model <preset-or-profile-name>
          const result = switchModel(arg);
          if (result) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: `✓ ${result}`, timestamp: Date.now() },
            ]);
          } else {
            // Maybe the user typed a raw model name (e.g. "gpt-4.1-mini")
            // Try as-is on the current provider
            setActiveModel(arg);
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `✓ Model changed to: ${arg} (provider: ${activeProvider})`,
                timestamp: Date.now(),
              },
            ]);
          }
          return true;
        }

        // ── /models ────────────────────────────────────────────────────
        case "/models": {
          const profileEntries = Object.entries(config.profiles || {});
          const presetEntries = Object.entries(MODEL_PRESETS);

          const lines: string[] = [];

          if (profileEntries.length > 0) {
            lines.push("━━━ Your Profiles ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            lines.push(`  ${"Name".padEnd(18)} ${"Provider".padEnd(12)} Model`);
            lines.push("  " + "─".repeat(60));
            for (const [name, p] of profileEntries) {
              const active = (p.model === activeModel && p.provider === activeProvider) ? " ◂" : "";
              lines.push(
                `  ${name.padEnd(18)} ${p.provider.padEnd(12)} ${p.model}${p.baseURL ? `  (${p.baseURL})` : ""}${active}`,
              );
            }
            lines.push("");
          }

          lines.push("━━━ Built-in Presets ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          lines.push(`  ${"Name".padEnd(18)} ${"Provider".padEnd(12)} Model`);
          lines.push("  " + "─".repeat(60));
          for (const [name, p] of presetEntries) {
            const active = (p.model === activeModel && p.type === activeProvider) ? " ◂" : "";
            lines.push(
              `  ${name.padEnd(18)} ${p.type.padEnd(12)} ${p.model}${p.baseURL ? `  (${p.baseURL})` : ""}${active}`,
            );
          }
          lines.push("");
          lines.push("Switch: /model <name>  •  Custom: /model set <provider> <model> [baseurl]");

          setMessages((prev) => [
            ...prev,
            { role: "system", content: lines.join("\n"), timestamp: Date.now() },
          ]);
          return true;
        }

        // ── /apikey ────────────────────────────────────────────────────
        case "/apikey": {
          const key = restArgs.join(""); // API keys may have special chars
          if (!key) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  `Current API key: ${activeApiKey ? activeApiKey.slice(0, 8) + "…" + activeApiKey.slice(-4) : "(not set)"}\n\n` +
                  "Usage: /apikey <your-api-key>\n\n" +
                  "This sets the key for the active provider. The key is kept in memory only\n" +
                  "and is NOT persisted to disk.",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }
          setActiveApiKey(key);
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `✓ API key set (${key.slice(0, 8)}…${key.slice(-4)}) for provider: ${activeProvider}`,
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        // ── /agent ─────────────────────────────────────────────────────
        case "/agent": {
          if (!arg) {
            const agents = agentManager.listAgents();
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  `Current agent: ${currentAgent}\n\nAvailable agents:\n` +
                  agents
                    .map(
                      (a) =>
                        `  ${a.name === currentAgent ? "▸" : " "} ${a.name.padEnd(8)} — ${a.description}`,
                    )
                    .join("\n") +
                  `\n\nUsage: /agent <name>`,
                timestamp: Date.now(),
              },
            ]);
            return true;
          }
          const name = arg as AgentName;
          if (!["code", "plan", "review"].includes(name)) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `Unknown agent: ${name}. Available: code, plan, review`,
                timestamp: Date.now(),
              },
            ]);
            return true;
          }
          setCurrentAgent(name);
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `Switched to ${name} agent.`,
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        case "/clear":
          setMessages([]);
          setTokenCount(0);
          setCost(0);
          return true;

        case "/compact": {
          const summary =
            messages.length > 0
              ? `[Conversation compacted: ${messages.length} messages → summary]\n` +
                `Topics discussed: ${messages
                  .filter((m) => m.role === "user")
                  .slice(-5)
                  .map((m) => m.content.slice(0, 50))
                  .join(", ")}`
              : "No messages to compact.";
          setMessages([
            { role: "system", content: summary, timestamp: Date.now() },
          ]);
          return true;
        }

        case "/cost": {
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `Token usage: ${tokenCount.toLocaleString()} total\nEstimated cost: $${cost.toFixed(4)}`,
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        case "/tools": {
          const tools = getToolDescriptions();
          const agentConfig = agentManager.getConfig(currentAgent);
          const perms = agentConfig.permissions;
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content:
                `Tools for ${currentAgent} agent:\n\n` +
                tools
                  .map((t) => {
                    const isWrite = ["Write", "Edit"].includes(t.name);
                    const isExec = t.name === "Bash";
                    const allowed =
                      (!isWrite && !isExec) ||
                      (isWrite && perms.allowWrite) ||
                      (isExec && perms.allowExecute);
                    return `  ${allowed ? "✓" : "✗"} ${t.name.padEnd(8)} ${t.description}`;
                  })
                  .join("\n"),
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        case "/exit":
          exit();
          return true;

        default:
          return false;
      }
    },
    [currentAgent, config, activeProvider, activeModel, activeApiKey, activeBaseURL, switchModel, messages, tokenCount, cost, exit],
  );

  // ── Submit handler ────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!input.trim() || isLoading) return;

    const trimmedInput = input.trim();
    setInput("");

    // Handle slash commands
    if (trimmedInput.startsWith("/")) {
      if (handleCommand(trimmedInput)) return;
      // Unknown command
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: `Unknown command: ${trimmedInput}. Type /help for available commands.`,
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    // Add user message
    const userMessage: Message = {
      role: "user",
      content: trimmedInput,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    // Check if API key is configured
    if (!activeApiKey) {
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content:
            "⚠ No API key configured.\n\n" +
            "Set one of:\n" +
            "  /apikey <your-key>              (in-app)\n" +
            "  export ZCODE_API_KEY=your-key    (env)\n" +
            "  export OPENAI_API_KEY=your-key   (env)\n" +
            "  export ANTHROPIC_API_KEY=your-key (env)\n\n" +
            "Or switch to a model with a configured key: /model <name>",
          timestamp: Date.now(),
        },
      ]);
      setIsLoading(false);
      return;
    }

    // Create agent and run
    try {
      const agent = agentManager.createAgent(currentAgent, providerConfig);
      agentRef.current = agent;

      // Determine thinking budget from toggle + prompt keywords
      const thinkingBudget = resolveThinkingBudget(thinkingEnabled, trimmedInput);

      const events = agent.run(
        trimmedInput,
        messages,
        workingDirectory,
        requestPermission,
        thinkingBudget,
      );

      await processAgentStream(events);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${(error as Error).message}`,
          timestamp: Date.now(),
          isError: true,
        },
      ]);
      setIsLoading(false);
    } finally {
      agentRef.current = null;
    }
  }, [input, isLoading, currentAgent, messages, activeApiKey, providerConfig, workingDirectory, handleCommand, requestPermission, processAgentStream]);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" height="100%">
      {/* Chat area */}
      <Box flexDirection="column" flexGrow={1}>
        <ChatPanel
          messages={messages}
          isLoading={isLoading}
          streamingText={streamingText}
          streamingThinking={streamingThinking}
          streamingToolUse={streamingToolUse}
          version="0.1.0"
          model={activeModel}
          workingDirectory={workingDirectory}
          agentName={currentAgent}
          providerType={activeProvider}
          baseURL={activeBaseURL}
        />
      </Box>

      {/* Permission prompt overlay */}
      {pendingPermission && (
        <PermissionPrompt
          toolName={pendingPermission.toolName}
          description={pendingPermission.description}
          onApprove={() => {
            pendingPermission.resolve(true);
            setPendingPermission(null);
          }}
          onDeny={() => {
            pendingPermission.resolve(false);
            setPendingPermission(null);
          }}
        />
      )}

      {/* Status bar */}
      <StatusBar
        model={activeModel}
        agentName={currentAgent}
        tokenCount={tokenCount}
        cost={cost}
        thinkingEnabled={thinkingEnabled}
      />

      {/* Input prompt */}
      <TextInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        isLoading={isLoading}
        agentName={currentAgent}
      />
    </Box>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Determine thinking token budget from toggle state + prompt keywords.
 * Keywords override the toggle — if you say "ultrathink", thinking is on regardless.
 * Returns 0 if thinking is off.
 */
function resolveThinkingBudget(enabled: boolean, prompt: string): number {
  const lower = prompt.toLowerCase();

  // Keyword detection (highest wins)
  if (lower.includes("ultrathink"))   return 128_000;
  if (lower.includes("megathink"))    return 60_000;
  if (lower.includes("think hard"))   return 30_000;
  if (lower.includes("think"))        return 10_000;

  // Toggle fallback
  if (enabled) return 10_000;

  return 0;
}

function formatToolInput(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
      return String(args.file_path || "");
    case "Write":
      return String(args.file_path || "");
    case "Edit":
      return String(args.file_path || "");
    case "Bash":
      return String(args.command || "");
    case "Glob":
      return `${args.pattern || "*"}${args.path ? ` in ${args.path}` : ""}`;
    case "Grep":
      return `"${args.pattern || ""}"${args.path ? ` in ${args.path}` : ""}`;
    case "LS":
      return String(args.path || ".");
    default:
      return JSON.stringify(args);
  }
}
