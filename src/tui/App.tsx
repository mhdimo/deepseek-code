// Main App component — real agent integration with streaming
//
// This wires together:
//   - Agent system (code/plan/review agents with tool calling)
//   - Streaming display (text + tool blocks in real-time)
//   - Permission prompts (approve/deny tool execution)
//   - Slash commands (/help, /agent, /clear, /model, /compact)
//   - Token tracking

import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, useApp, useInput } from "ink";
import ChatPanel from "./ChatPanel.js";
import CommandPicker, { filterCommands } from "./CommandPicker.js";
import type { CommandDef } from "./CommandPicker.js";
import ShortcutOverlay from "./ShortcutOverlay.js";
import StatusBar from "./StatusBar.js";
import TextInput from "./TextInput.js";
import PermissionPrompt from "./PermissionPrompt.js";
import { agentManager, Agent } from "../agent/index.js";
import { getToolDescriptions } from "../tool/index.ts";
import type {
  Message,
  ToolUseBlock,
  AgentEvent,
  AgentName,
  ProviderConfig,
  ProviderType,
  ZCodeConfig,
  ThinkingMode,
  MCPServerConfig,
} from "../core/types.js";

// ── Thinking mode constants ───────────────────────────────────────────────
const THINKING_CYCLE: ThinkingMode[] = ["off", "light", "deep", "max"];
const THINKING_BUDGETS: Record<ThinkingMode, number> = {
  off:   0,
  light: 10_000,
  deep:  32_000,
  max:   128_000,
};

const OPENAI_COMPAT_ENDPOINT_HINTS: Array<{ test: RegExp; baseURL: string; label: string }> = [
  { test: /^glm-/i, baseURL: "https://api.z.ai/api/coding/paas/v4", label: "Z.AI (GLM)" },
  { test: /^deepseek/i, baseURL: "https://api.deepseek.com/v1", label: "DeepSeek" },
  { test: /llama|mixtral|qwen|gemma/i, baseURL: "https://api.groq.com/openai/v1", label: "Groq/Together-style endpoint" },
];

interface QuickSetupPreset {
  aliases: string[];
  provider: ProviderType;
  model: string;
  baseURL?: string;
  label: string;
}

const QUICK_SETUP_PRESETS: QuickSetupPreset[] = [
  {
    aliases: ["openai", "gpt", "gpt4o", "gpt-4o"],
    provider: "openai",
    model: "gpt-4o",
    label: "OpenAI",
  },
  {
    aliases: ["anthropic", "claude"],
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    label: "Anthropic",
  },
  {
    aliases: ["glm", "zai", "z.ai"],
    provider: "openai",
    model: "glm-4.7",
    baseURL: "https://api.z.ai/api/coding/paas/v4",
    label: "Z.AI (GLM)",
  },
  {
    aliases: ["deepseek", "ds"],
    provider: "openai",
    model: "deepseek-chat",
    baseURL: "https://api.deepseek.com/v1",
    label: "DeepSeek",
  },
  {
    aliases: ["groq"],
    provider: "openai",
    model: "llama-3.3-70b-versatile",
    baseURL: "https://api.groq.com/openai/v1",
    label: "Groq",
  },
];

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
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("off");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [commandPickerIndex, setCommandPickerIndex] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [inputResetKey, setInputResetKey] = useState(0);
  const [queuedSubmissions, setQueuedSubmissions] = useState<string[]>([]);

  // MCP runtime state (loaded from config)
  const [mcpServers, setMcpServers] = useState<Record<string, MCPServerConfig>>(
    config.mcpServers || {},
  );

  const agentRef = useRef<Agent | null>(null);
  /** Lets handleSubmit know the picker is intercepting Enter */
  const pickerActiveRef = useRef(false);

  // Helper: yield to the event loop so React/Ink can render between tokens
  const yieldToRenderer = () => new Promise<void>((r) => setTimeout(r, 0));

  // ── Command picker (derived) ──────────────────────────────────────────
  const filteredCommands: CommandDef[] = !isLoading ? filterCommands(input) : [];
  // Hide picker once the user has typed an exact command name (ready to press Enter)
  const isExactCommandMatch =
    filteredCommands.length === 1 && filteredCommands[0]?.name === input.toLowerCase();
  const showCommandPicker = filteredCommands.length > 0 && !isExactCommandMatch;
  // Keep ref in sync every render so handleSubmit can read it without stale closure
  pickerActiveRef.current = showCommandPicker;

  const mcpEntries = Object.entries(mcpServers);
  const mcpCount = mcpEntries.length;
  const mcpEnabledCount = mcpEntries.filter(([, s]) => s.enabled !== false).length;

  // Derived — always reflects current mutable state
  const providerConfig: ProviderConfig = {
    type: activeProvider,
    apiKey: activeApiKey,
    baseURL: activeBaseURL,
    model: activeModel,
  };

  // Helper: switch to a named profile
  const switchModel = useCallback(
    (name: string): string | null => {
      const profile = config.profiles?.[name];
      if (profile) {
        setActiveProvider(profile.provider);
        setActiveModel(profile.model);
        setActiveApiKey(profile.apiKey);
        setActiveBaseURL(profile.baseURL);
        return `Switched to profile "${name}" → ${profile.provider}/${profile.model}${profile.baseURL ? ` (${profile.baseURL})` : ""}`;
      }

      return null; // not found
    },
    [config.profiles],
  );

  // ── Keybindings ───────────────────────────────────────────────────────
  useInput((_input, key) => {
    // Ctrl+C: quit
    if (key.ctrl && _input === "c") {
      agentRef.current?.abort();
      exit();
      return;
    }

    // ? toggles shortcuts panel (only when input is empty, to avoid accidental popups while typing)
    if (_input === "?" && !isLoading && input.trim().length === 0 && !showCommandPicker) {
      setShowShortcuts((prev) => !prev);
      return;
    }

    // Escape: interrupt generation OR dismiss picker
    if (key.escape) {
      if (isLoading) {
        agentRef.current?.abort();
        setIsLoading(false);
        setStreamingText("");
        setStreamingThinking("");
        setStreamingToolUse([]);
        setMessages((prev) => [
          ...prev,
          { role: "system", content: "⚠ Generation interrupted.", timestamp: Date.now() },
        ]);
      } else if (showCommandPicker) {
        setInput("");
        setCommandPickerIndex(0);
      } else if (showShortcuts) {
        setShowShortcuts(false);
      }
      return;
    }

    // Command picker navigation (only while picker is open)
    if (showCommandPicker && filteredCommands.length > 0) {
      if (key.upArrow) {
        setCommandPickerIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setCommandPickerIndex((prev) => Math.min(filteredCommands.length - 1, prev + 1));
        return;
      }
      if (key.tab || key.return) {
        const safeIdx = Math.min(commandPickerIndex, filteredCommands.length - 1);
        const cmd = filteredCommands[safeIdx];
        if (cmd) {
          // usage = fill text with trailing space (user adds args)
          // no usage = fill command name exactly (user presses Enter to run)
          setInput(cmd.usage ?? cmd.name);
          // Remount text input so cursor lands at end after programmatic insertion
          setInputResetKey((prev) => prev + 1);
          setCommandPickerIndex(0);
        }
        return;
      }
    }

    // Reset picker selection index on any non-navigation keypress
    if (!key.upArrow && !key.downArrow && !key.tab && !key.return) {
      setCommandPickerIndex(0);
    }

    // Shift+Tab: cycle thinking mode  off → light → deep → max → off
    if (key.shift && key.tab && !isLoading) {
      setThinkingMode((prev) => {
        const idx = THINKING_CYCLE.indexOf(prev);
        const next = THINKING_CYCLE[(idx + 1) % THINKING_CYCLE.length]!;
        return next;
      });
      return;
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

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      if (showShortcuts && value.trim().length > 0) {
        setShowShortcuts(false);
      }
    },
    [showShortcuts],
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
                    isExpanded:
                      event.result.startsWith("❌") ||
                      event.toolName === "Write" ||
                      event.toolName === "Edit",
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

  const submitUserPrompt = useCallback(
    async (trimmedInput: string) => {
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
              "  /setup <preset> <your-key>        (quick setup)\n" +
              "  /setup custom <provider> <model> <your-key> [baseurl]\n" +
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

        // Thinking budget comes from the explicit mode setting only
        const thinkingBudget = THINKING_BUDGETS[thinkingMode];

        const events = agent.run(
          trimmedInput,
          messages,
          workingDirectory,
          requestPermission,
          thinkingBudget,
        );

        await processAgentStream(events);
      } catch (error) {
        const raw = (error as Error).message || String(error);
        const hint = inferBaseURLForModel(activeModel);
        const looksLikeWrongEndpoint =
          activeProvider === "openai" &&
          !activeBaseURL &&
          !!hint &&
          /incorrect api key provided|invalid api key/i.test(raw);

        const friendly = looksLikeWrongEndpoint
          ? [
              raw,
              "",
              `Tip: model '${activeModel}' likely needs a custom OpenAI-compatible endpoint.`,
              `Try: /baseurl ${hint.baseURL}`,
              `Then run again.`,
            ].join("\n")
          : `Error: ${raw}`;

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: friendly,
            timestamp: Date.now(),
            isError: true,
          },
        ]);
        setIsLoading(false);
      } finally {
        agentRef.current = null;
      }
    },
    [
      activeApiKey,
      currentAgent,
      providerConfig,
      thinkingMode,
      messages,
      workingDirectory,
      requestPermission,
      processAgentStream,
      activeModel,
      activeProvider,
      activeBaseURL,
    ],
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
                "  /setup               Guided one-command model/api setup",
                "  /setup <preset> <key> [model]",
                "                       Quick setup using a built-in preset",
                "  /setup custom <provider> <model> <key> [baseurl]",
                "                       Set provider/model/key in one command",
                "  /model               Show current model info",
                "  /model <name>        Switch to a profile, or set model id directly",
                "  /model set <provider> <model> [baseurl]",
                "                       Set a custom OpenAI-compatible model",
                "  /baseurl <url>       Set custom endpoint URL",
                "  /baseurl clear       Clear custom endpoint URL",
                "  /models              List configured profiles",
                "  /apikey <key>        Set the API key for current provider",
                "  /agent <name>        Switch agent (code, plan, review)",
                "  /mcp                 Show MCP servers and status",
                "  /mcp enable <name>   Enable an MCP server",
                "  /mcp disable <name>  Disable an MCP server",
                "  /shortcuts           Toggle shortcuts panel",
                "  /clear               Clear conversation history",
                "  /compact             Summarize conversation to save context",
                "  /tools               List available tools",
                "  /exit                Exit z-code",
                "",
                "━━━ Agents ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                ...agents.map((a) =>
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
                "  Shift+Tab          Cycle thinking mode",
                "  ↑↓ arrows          Navigate command picker (type / first)",
                "  ?                  Toggle shortcuts panel",
                "  Ctrl+C             Exit",
                "  Esc                Interrupt generation / dismiss picker",
                "",
                "━━━ Thinking ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                `  Active mode: ${thinkingMode === "off" ? "off (disabled)" : thinkingMode}`,
                "  Shift+Tab        Cycle: off → light → deep → max → off",
                "  /think           Same via command",
                "  /think off       Disable",
                "  /think light     10k token budget",
                "  /think deep      32k token budget",
                "  /think max       128k token budget",
                "",
                "━━━ MCP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                `  Servers configured: ${mcpCount}`,
                `  Servers enabled:    ${mcpEnabledCount}`,
                "  /mcp              List all MCP servers",
              ].join("\n"),
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        // ── /setup ─────────────────────────────────────────────────────
        case "/setup": {
          const mode = (parts[1] || "").toLowerCase();

          if (!mode) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: [
                  "Quick setup (provider + model + API key in one command)",
                  "",
                  "Presets:",
                  "  /setup openai <api-key>",
                  "  /setup anthropic <api-key>",
                  "  /setup glm <api-key>",
                  "  /setup deepseek <api-key>",
                  "  /setup groq <api-key>",
                  "",
                  "Optional model override:",
                  "  /setup openai <api-key> gpt-4.1-mini",
                  "",
                  "Custom provider/model:",
                  "  /setup custom <provider> <model> <api-key> [baseurl]",
                  "",
                  "Current:",
                  `  provider: ${activeProvider}`,
                  `  model:    ${activeModel}`,
                  `  baseURL:  ${activeBaseURL || "(default)"}`,
                  `  key:      ${activeApiKey ? activeApiKey.slice(0, 8) + "…" + activeApiKey.slice(-4) : "(not set)"}`,
                ].join("\n"),
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          if (mode === "custom") {
            const provider = parts[2] as ProviderType | undefined;
            const model = parts[3];
            const key = parts[4];
            const baseURL = parts[5];

            if (!provider || !model || !key) {
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content:
                    "Usage: /setup custom <provider> <model> <api-key> [baseurl]\n\n" +
                    "Examples:\n" +
                    "  /setup custom openai gpt-4o sk-...\n" +
                    "  /setup custom openai glm-4.7 sk-... https://api.z.ai/api/coding/paas/v4\n" +
                    "  /setup custom anthropic claude-sonnet-4-20250514 sk-ant-...",
                  timestamp: Date.now(),
                },
              ]);
              return true;
            }

            if (provider !== "openai" && provider !== "anthropic") {
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content: `Unknown provider: ${provider}. Allowed: openai, anthropic`,
                  timestamp: Date.now(),
                },
              ]);
              return true;
            }

            setActiveProvider(provider);
            setActiveModel(model);
            setActiveApiKey(key);
            setActiveBaseURL(baseURL || undefined);

            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  `✓ Setup complete → ${provider}/${model}` +
                  (baseURL ? ` (${baseURL})` : "") +
                  `\n✓ API key saved in memory (${key.slice(0, 8)}…${key.slice(-4)})`,
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          const preset = findQuickSetupPreset(mode);
          if (!preset) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  `Unknown setup preset: ${mode}\n\n` +
                  "Try one of: openai, anthropic, glm, deepseek, groq\n" +
                  "Or use: /setup custom <provider> <model> <api-key> [baseurl]",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          const key = parts[2];
          const modelOverride = parts[3];
          if (!key) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  `Usage: /setup ${preset.aliases[0]} <api-key> [model]\n\n` +
                  `Example: /setup ${preset.aliases[0]} your-key-here ${preset.model}`,
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          const resolvedModel = modelOverride || preset.model;
          setActiveProvider(preset.provider);
          setActiveModel(resolvedModel);
          setActiveApiKey(key);
          setActiveBaseURL(preset.baseURL);

          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content:
                `✓ Setup complete → ${preset.provider}/${resolvedModel}` +
                (preset.baseURL ? ` (${preset.baseURL})` : "") +
                `\n✓ Provider preset: ${preset.label}` +
                `\n✓ API key saved in memory (${key.slice(0, 8)}…${key.slice(-4)})`,
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
                  "Quick switch:  /model <profile-name>",
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

          // /model <profile-name>
          const result = switchModel(arg);
          if (result) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: `✓ ${result}`, timestamp: Date.now() },
            ]);
          } else {
            // Maybe the user typed a raw model name (e.g. "gpt-4.1-mini")
            // Try as-is on the current provider
            const hint = inferBaseURLForModel(arg);
            setActiveModel(arg);
            if (activeProvider === "openai" && !activeBaseURL && hint) {
              setActiveBaseURL(hint.baseURL);
            }
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  `✓ Model changed to: ${arg} (provider: ${activeProvider})` +
                  (activeProvider === "openai" && !activeBaseURL && hint
                    ? `\n✓ Auto endpoint set: ${hint.baseURL} (${hint.label})`
                    : ""),
                timestamp: Date.now(),
              },
            ]);
          }
          return true;
        }

        // ── /models ────────────────────────────────────────────────────
        case "/models": {
          const profileEntries = Object.entries(config.profiles || {});

          const lines: string[] = [];

          if (profileEntries.length === 0) {
            lines.push("No profiles configured.");
            lines.push("");
            lines.push("Add profiles to .zcode.json under \"profiles\".");
            lines.push("Or use /model set <provider> <model> [baseurl].");
          } else {
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
            lines.push("Switch: /model <profile-name>  •  Custom: /model set <provider> <model> [baseurl]");
          }

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
                  "Tip: use /setup for one-command setup of provider/model/key.\n\n" +
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

        // ── /baseurl ───────────────────────────────────────────────────
        case "/baseurl": {
          const url = restArgs.join(" ").trim();
          if (!url) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  `Current base URL: ${activeBaseURL || "(default provider URL)"}\n\n` +
                  "Usage:\n" +
                  "  /baseurl <url>    Set OpenAI-compatible endpoint\n" +
                  "  /baseurl clear    Clear custom endpoint",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          if (url.toLowerCase() === "clear") {
            setActiveBaseURL(undefined);
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "✓ Cleared custom base URL.", timestamp: Date.now() },
            ]);
            return true;
          }

          setActiveBaseURL(url);
          setMessages((prev) => [
            ...prev,
            { role: "system", content: `✓ Base URL set to: ${url}`, timestamp: Date.now() },
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

        case "/shortcuts": {
          setShowShortcuts((prev) => !prev);
          return true;
        }

        case "/mcp": {
          const action = parts[1]?.toLowerCase();
          const serverName = parts[2];

          if (!action || action === "list") {
            if (mcpEntries.length === 0) {
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content:
                    "No MCP servers configured.\n\n" +
                    "Add \"mcpServers\" to your .zcode.json, e.g.:\n" +
                    "  \"mcpServers\": {\n" +
                    "    \"filesystem\": { \"command\": \"npx\", \"args\": [\"-y\", \"@modelcontextprotocol/server-filesystem\", \".\"] }\n" +
                    "  }",
                  timestamp: Date.now(),
                },
              ]);
              return true;
            }

            const lines = [
              "MCP Servers:",
              "",
              ...mcpEntries.map(([name, s]) => {
                const enabled = s.enabled !== false;
                const args = (s.args || []).join(" ");
                return `  ${enabled ? "✓" : "✗"} ${name.padEnd(16)} ${s.command}${args ? ` ${args}` : ""}`;
              }),
              "",
              "Commands:",
              "  /mcp enable <name>",
              "  /mcp disable <name>",
            ];

            setMessages((prev) => [
              ...prev,
              { role: "system", content: lines.join("\n"), timestamp: Date.now() },
            ]);
            return true;
          }

          if ((action === "enable" || action === "disable") && serverName) {
            if (!mcpServers[serverName]) {
              setMessages((prev) => [
                ...prev,
                { role: "system", content: `Unknown MCP server: ${serverName}`, timestamp: Date.now() },
              ]);
              return true;
            }

            const enabled = action === "enable";
            setMcpServers((prev) => ({
              ...prev,
              [serverName]: {
                ...prev[serverName]!,
                enabled,
              },
            }));
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `${enabled ? "✓" : "✗"} MCP server ${serverName} ${enabled ? "enabled" : "disabled"}.`,
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: "Usage:\n  /mcp\n  /mcp enable <name>\n  /mcp disable <name>",
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        case "/think": {
          const VALID_MODES: ThinkingMode[] = ["off", "light", "deep", "max"];
          if (arg && VALID_MODES.includes(arg as ThinkingMode)) {
            const newMode = arg as ThinkingMode;
            setThinkingMode(newMode);
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: newMode === "off"
                  ? "💭 Thinking disabled."
                  : `💭 Thinking → ${newMode}  (${THINKING_BUDGETS[newMode] / 1000}k token budget).`,
                timestamp: Date.now(),
              },
            ]);
          } else if (!arg) {
            // No argument → cycle to next mode
            const cur = thinkingMode;
            const idx = THINKING_CYCLE.indexOf(cur);
            const next = THINKING_CYCLE[(idx + 1) % THINKING_CYCLE.length]!;
            setThinkingMode(next);
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: next === "off"
                  ? "💭 Thinking disabled."
                  : `💭 Thinking → ${next}  (${THINKING_BUDGETS[next] / 1000}k token budget).`,
                timestamp: Date.now(),
              },
            ]);
          } else {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  "Usage: /think [off|light|deep|max]\n" +
                  "Shift+Tab also cycles through modes.\n\n" +
                  "  off    disabled\n" +
                  "  light  10k token budget\n" +
                  "  deep   32k token budget\n" +
                  "  max    128k token budget",
                timestamp: Date.now(),
              },
            ]);
          }
          return true;
        }

        case "/exit":
          exit();
          return true;

        default:
          return false;
      }
    },
    [
      currentAgent,
      config,
      activeProvider,
      activeModel,
      activeApiKey,
      activeBaseURL,
      switchModel,
      messages,
      tokenCount,
      exit,
      thinkingMode,
      mcpEntries,
      mcpCount,
      mcpEnabledCount,
      mcpServers,
    ],
  );

  // ── Submit handler ────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!input.trim()) return;
    // Command picker is open — Enter selects a command, doesn't submit
    if (pickerActiveRef.current) return;

    const trimmedInput = input.trim();
    setInput("");

    // Slash commands while generating are blocked (except Esc interrupt), to keep state simple
    if (isLoading && trimmedInput.startsWith("/")) {
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: "A response is currently running. Press Esc to interrupt, then run commands.",
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    // Handle slash commands when idle
    if (!isLoading && trimmedInput.startsWith("/")) {
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

    // While generating, queue normal prompts (Claude Code style)
    if (isLoading) {
      setQueuedSubmissions((prev) => [...prev, trimmedInput]);
      return;
    }

    await submitUserPrompt(trimmedInput);
  }, [input, isLoading, handleCommand, submitUserPrompt]);

  // Auto-drain queued prompts once current generation is done
  useEffect(() => {
    if (isLoading) return;
    if (queuedSubmissions.length === 0) return;

    const [next, ...rest] = queuedSubmissions;
    setQueuedSubmissions(rest);
    void submitUserPrompt(next!);
  }, [isLoading, queuedSubmissions, submitUserPrompt]);

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

      {/* Shortcut/options panel */}
      {showShortcuts && (
        <ShortcutOverlay
          thinkingMode={thinkingMode}
          mcpCount={mcpCount}
          mcpEnabledCount={mcpEnabledCount}
        />
      )}

      {/* Status bar */}
      <StatusBar
        model={activeModel}
        agentName={currentAgent}
        tokenCount={tokenCount}
        thinkingMode={thinkingMode}
        mcpEnabledCount={mcpEnabledCount}
        queueCount={queuedSubmissions.length}
      />

      {/* Command picker — visible while user types "/" */}
      {showCommandPicker && (
        <CommandPicker
          commands={filteredCommands}
          selectedIndex={Math.min(commandPickerIndex, Math.max(0, filteredCommands.length - 1))}
        />
      )}

      {/* Input prompt */}
      <TextInput
        inputResetKey={inputResetKey}
        value={input}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        isLoading={isLoading}
        agentName={currentAgent}
      />
    </Box>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

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

function inferBaseURLForModel(model: string): { baseURL: string; label: string } | null {
  const m = model.trim();
  for (const hint of OPENAI_COMPAT_ENDPOINT_HINTS) {
    if (hint.test.test(m)) {
      return { baseURL: hint.baseURL, label: hint.label };
    }
  }
  return null;
}

function findQuickSetupPreset(name: string): QuickSetupPreset | null {
  const n = name.trim().toLowerCase();
  for (const preset of QUICK_SETUP_PRESETS) {
    if (preset.aliases.some((a) => a.toLowerCase() === n)) return preset;
  }
  return null;
}
