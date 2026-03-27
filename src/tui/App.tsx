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
  DeepSeekCodeConfig,
  ThinkingMode,
  MCPServerConfig,
} from "../core/types.js";
import {
  saveSettings,
  saveSession,
  updateSession,
  loadSession,
  listSessions,
  pruneSessions,
} from "../core/storage.js";

// ── Thinking mode constants ───────────────────────────────────────────────

export default function App({ config, workingDirectory, resumeSessionHash: cliResumeHash }: { config: DeepSeekCodeConfig; workingDirectory: string; resumeSessionHash?: string }) {
  const { exit } = useApp();

  // ── State ─────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingToolUse, setStreamingToolUse] = useState<ToolUseBlock[]>([]);
  const [currentAgent, setCurrentAgent] = useState<AgentName>(config.defaultAgent || "code");
  const [tokenCount, setTokenCount] = useState(0);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<{
    toolName: string;
    description: string;
    resolve: (decision: { approved: boolean; feedback?: string }) => void;
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
  /** Ref to handleSubmit so useInput can call it without stale closure */
  const handleSubmitRef = useRef<() => void>(() => {});

  // ── Session state ────────────────────────────────────────────────────
  const [activeSessionHash, setActiveSessionHash] = useState<string | null>(null);

  // ── Input history ────────────────────────────────────────────────────
  const inputHistory = useRef<string[]>([]);
  const historyIndex = useRef(-1); // -1 = not navigating history

  // ── Persist settings helper ──────────────────────────────────────────
  const persistSettings = useCallback((updates: {
    apiKey?: string;
    model?: string;
    baseURL?: string | undefined;
    provider?: string;
    defaultAgent?: string;
  }) => {
    try {
      saveSettings(updates);
    } catch {
      // Best-effort persistence
    }
  }, []);

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

  // ── Session auto-save ────────────────────────────────────────────────
  // Save session whenever messages change
  useEffect(() => {
    if (messages.length === 0) return;
    try {
      const sessionMessages = messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        isError: m.isError,
      }));

      if (activeSessionHash) {
        updateSession(activeSessionHash, {
          messages: sessionMessages,
          tokenUsage: tokenCount,
        });
      } else {
        const hash = saveSession({
          messages: sessionMessages,
          tokenUsage: tokenCount,
          model: activeModel,
          agent: currentAgent,
          workingDirectory,
        });
        setActiveSessionHash(hash);
        // Prune old sessions
        pruneSessions(50);
      }
    } catch {
      // Best-effort
    }
  }, [messages.length]);

  // ── Resume session ONLY when --resume <hash> is passed explicitly ────
  useEffect(() => {
    if (!cliResumeHash) return; // No --resume flag → fresh session
    try {
      const session = loadSession(cliResumeHash);
      if (session && session.messages.length > 0) {
        setMessages(session.messages.map((m) => ({
          ...m,
          toolUse: [],
        })));
        setTokenCount(session.tokenUsage);
        setActiveSessionHash(session.hash);
      }
    } catch {
      // Fresh start on error
    }
  }, []);

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
      if (pendingPermission) {
        pendingPermission.resolve({ approved: false, feedback: "Cancelled with Esc" });
        setPendingPermission(null);
      } else if (isLoading) {
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
          if (key.return) {
            // Enter → execute the command immediately (even ones that take args)
            setInput(cmd.name);
            setInputResetKey((prev) => prev + 1);
            setTimeout(() => {
              handleSubmitRef.current();
            }, 0);
          } else {
            // Tab → autocomplete (fill usage template with trailing space)
            setInput(cmd.usage ?? cmd.name);
            setInputResetKey((prev) => prev + 1);
          }
          setCommandPickerIndex(0);
        }
        return;
      }
    }

    // Reset picker selection index on any non-navigation keypress
    if (!key.upArrow && !key.downArrow && !key.tab && !key.return) {
      setCommandPickerIndex(0);
    }

    // Input history navigation (when picker is not active)
    if (!showCommandPicker && !isLoading) {
      if (key.upArrow) {
        if (inputHistory.current.length === 0) return;
        if (historyIndex.current === -1) {
          // Start navigating from the most recent entry
          historyIndex.current = inputHistory.current.length - 1;
        } else if (historyIndex.current > 0) {
          historyIndex.current -= 1;
        }
        const historical = inputHistory.current[historyIndex.current];
        if (historical !== undefined) {
          setInput(historical);
          setInputResetKey((prev) => prev + 1);
        }
        return;
      }
      if (key.downArrow) {
        if (historyIndex.current === -1) return;
        if (historyIndex.current < inputHistory.current.length - 1) {
          historyIndex.current += 1;
          const historical = inputHistory.current[historyIndex.current];
          if (historical !== undefined) {
            setInput(historical);
            setInputResetKey((prev) => prev + 1);
          }
        } else {
          // Bottom of history — clear input
          historyIndex.current = -1;
          setInput("");
          setInputResetKey((prev) => prev + 1);
        }
        return;
      }
    }

    // Shift+Tab: toggle whalethink mode
    if (key.shift && key.tab && !isLoading) {
      setThinkingMode((prev) => prev === "off" ? "whale" : "off");
      return;
    }
  });

  // ── Permission callback ───────────────────────────────────────────────
  const requestPermission = useCallback(
    (toolName: string, description: string): Promise<{ approved: boolean; feedback?: string }> => {
      if (config.dangerouslySkipPermissions) return Promise.resolve({ approved: true });
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
            // Track current file for status bar
            const filePath = event.args?.file_path as string | undefined;
            if (filePath) {
              setCurrentFile(filePath);
            }
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
            // Clear current file when tool completes
            setCurrentFile(null);

            // Save intermediate step as a message so the user sees it
            if (text || toolUse.length > 0) {
              const stepMessage: Message = {
                role: "assistant",
                content: text,
                timestamp: Date.now(),
                toolUse: toolUse.length > 0 ? [...toolUse] : undefined,
                thinking: thinking || undefined,
              };
              setMessages((prev) => [...prev, stepMessage]);
            }

            // Reset streaming state for next step
            text = "";
            thinking = "";
            toolUse = [];
            setStreamingText("");
            setStreamingThinking("");
            setStreamingToolUse([]);
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
              "  /setup <your-key>              (quick setup)\n" +
              "  /apikey <your-key>             (in-app)\n" +
              "  export DEEPSEEK_API_KEY=your-key    (env)\n\n" +
              "Get your key at: https://platform.deepseek.com/api_keys",
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

        const events = agent.run(
          trimmedInput,
          messages,
          workingDirectory,
          requestPermission,
        );

        await processAgentStream(events);
      } catch (error) {
        const raw = (error as Error).message || String(error);

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Error: ${raw}`,
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
                "  /exit                Exit DeepSeek Code",
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
                `  Active mode: ${thinkingMode === "off" ? "off (disabled)" : "🐋 whalethink"}`,
                "  Shift+Tab        Toggle whalethink on/off",
                "  /think           Same via command",
                "  /think off       Disable extended thinking",
                "  /think whale     Enable whalethink (deep reasoning)",
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
                  "Quick setup for DeepSeek Code",
                  "",
                  "Usage:",
                  "  /setup <api-key>           Use deepseek-chat (default)",
                  "  /setup <api-key> reasoner  Use deepseek-reasoner",
                  "",
                  "Examples:",
                  "  /setup sk-xxxxx",
                  "  /setup sk-xxxxx deepseek-reasoner",
                  "",
                  "Current:",
                  `  model:    ${activeModel}`,
                  `  baseURL:  ${activeBaseURL || "(default)"}`,
                  `  key:      ${activeApiKey ? activeApiKey.slice(0, 8) + "…" + activeApiKey.slice(-4) : "(not set)"}`,
                ].join("\n"),
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          // /setup <api-key> [model]
          const key = parts[2];
          const modelOverride = parts[3];

          if (!key) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  "Usage: /setup <api-key> [model]\n\n" +
                  "Examples:\n" +
                  "  /setup sk-xxxxx\n" +
                  "  /setup sk-xxxxx deepseek-reasoner\n\n" +
                  "Models: deepseek-chat (default), deepseek-reasoner",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          const resolvedModel = modelOverride || "deepseek-chat";
          setActiveProvider("deepseek");
          setActiveModel(resolvedModel);
          setActiveApiKey(key);
          setActiveBaseURL(undefined);
          persistSettings({ apiKey: key, model: resolvedModel, provider: "deepseek" });

          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content:
                `✓ Setup complete → deepseek/${resolvedModel}` +
                `\n✓ API key saved (${key.slice(0, 8)}…${key.slice(-4)})` +
                `\n✓ Settings persisted to ~/.deepseek-code/settings.json`,
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
                  "Switch model:  /model <model-name>",
                  "Use profile:   /model <profile-name>",
                  "Set API key:   /apikey <key>",
                  "",
                  "Available models: deepseek-chat, deepseek-reasoner",
                ].join("\n"),
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          // /model <model-name> or /model <profile-name>
          const result = switchModel(arg);
          if (result) {
            persistSettings({ model: arg, apiKey: config.profiles?.[arg]?.apiKey });
            setMessages((prev) => [
              ...prev,
              { role: "system", content: `✓ ${result}\n✓ Saved to ~/.deepseek-code/settings.json`, timestamp: Date.now() },
            ]);
          } else {
            // Try as a raw model name
            setActiveModel(arg);
            persistSettings({ model: arg });
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `✓ Model changed to: ${arg}\n✓ Saved to ~/.deepseek-code/settings.json`,
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
            lines.push("Add profiles to .deepseek-code.json under \"profiles\".");
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
          persistSettings({ apiKey: key });
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `✓ API key set (${key.slice(0, 8)}…${key.slice(-4)}) for provider: ${activeProvider}\n✓ Saved to ~/.deepseek-code/settings.json`,
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
                    "Add \"mcpServers\" to your .deepseek-code.json, e.g.:\n" +
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
          const VALID_MODES: ThinkingMode[] = ["off", "whale"];
          if (arg && VALID_MODES.includes(arg as ThinkingMode)) {
            const newMode = arg as ThinkingMode;
            setThinkingMode(newMode);
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: newMode === "off"
                  ? "💭 Thinking disabled."
                  : "🐋 Whalethink enabled — deep reasoning mode active.",
                timestamp: Date.now(),
              },
            ]);
          } else if (!arg) {
            // No argument → toggle
            const next = thinkingMode === "off" ? "whale" : "off";
            setThinkingMode(next);
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: next === "off"
                  ? "💭 Thinking disabled."
                  : "🐋 Whalethink enabled — deep reasoning mode active.",
                timestamp: Date.now(),
              },
            ]);
          } else {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  "Usage: /think [off|whale]\n" +
                  "Shift+Tab also toggles whalethink.\n\n" +
                  "  off    disabled\n" +
                  "  whale  deep reasoning with extended thinking",
                timestamp: Date.now(),
              },
            ]);
          }
          return true;
        }

        case "/exit":
          if (activeSessionHash) {
            // Show resume hint before exiting — printed to stdout after Ink unmounts
            process.stderr.write(`\n  Session saved: ${activeSessionHash}\n  Resume with: deepseek-code --resume ${activeSessionHash}\n\n`);
          }
          exit();
          return true;

        // ── /sessions ───────────────────────────────────────────────────
        case "/sessions": {
          const sessions = listSessions();
          if (sessions.length === 0) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "No saved sessions.", timestamp: Date.now() },
            ]);
            return true;
          }
          const lines = [
            "Saved sessions (newest first):",
            "",
            ...sessions.slice(0, 20).map((s, i) => {
              const date = new Date(s.updatedAt).toLocaleString();
              const msgCount = s.messages.filter((m) => m.role === "user").length;
              const active = s.hash === activeSessionHash ? " ◂ active" : "";
              return `  ${String(i + 1).padStart(2)}. ${s.hash}  ${date}  ${msgCount} msgs  ${s.model}${active}`;
            }),
            "",
            "Resume: /resume <hash>",
            "Clear:  /sessions clear",
          ];
          setMessages((prev) => [
            ...prev,
            { role: "system", content: lines.join("\n"), timestamp: Date.now() },
          ]);
          return true;
        }

        // ── /resume ─────────────────────────────────────────────────────
        case "/resume": {
          if (!arg) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: "Usage: /resume <session-hash>\n\nUse /sessions to list available sessions.",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }
          if (arg === "clear" || arg === "new") {
            setMessages([]);
            setTokenCount(0);
            setActiveSessionHash(null);
            setMessages([{ role: "system", content: "✓ Started a new session.", timestamp: Date.now() }]);
            return true;
          }
          const session = loadSession(arg);
          if (!session) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: `Session not found: ${arg}`, timestamp: Date.now() },
            ]);
            return true;
          }
          setMessages(session.messages.map((m) => ({ ...m, toolUse: [] })));
          setTokenCount(session.tokenUsage);
          setActiveSessionHash(session.hash);
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `✓ Resumed session ${session.hash} (${session.messages.length} messages, ${new Date(session.createdAt).toLocaleString()})`,
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

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

    // Push to input history (skip duplicates)
    if (trimmedInput && inputHistory.current[inputHistory.current.length - 1] !== trimmedInput) {
      inputHistory.current.push(trimmedInput);
      if (inputHistory.current.length > 100) inputHistory.current.shift();
    }
    historyIndex.current = -1;

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

    // Auto-detect API key paste (starts with sk- and no key configured)
    if (!activeApiKey && trimmedInput.startsWith("sk-") && trimmedInput.length >= 20 && !trimmedInput.includes(" ")) {
      setActiveApiKey(trimmedInput);
      setActiveProvider("deepseek");
      setActiveModel("deepseek-chat");
      persistSettings({ apiKey: trimmedInput, model: "deepseek-chat", provider: "deepseek" });
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content:
            `✓ API key detected and saved (${trimmedInput.slice(0, 8)}…${trimmedInput.slice(-4)})\n` +
            `✓ Using deepseek-chat. Change with /model <name>.\n` +
            `✓ Settings persisted to ~/.deepseek-code/settings.json`,
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

  // Keep handleSubmit ref in sync so command picker Enter can call it
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

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
          hasApiKey={!!activeApiKey}
        />
      </Box>

      {/* Permission prompt overlay */}
      {pendingPermission && (
        <PermissionPrompt
          toolName={pendingPermission.toolName}
          description={pendingPermission.description}
          onApprove={(feedback) => {
            pendingPermission.resolve({ approved: true, feedback });
            setPendingPermission(null);
          }}
          onDeny={(feedback) => {
            pendingPermission.resolve({ approved: false, feedback });
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
        currentFile={currentFile}
        awaitingPermission={!!pendingPermission}
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
        workingDirectory={workingDirectory}
        recentFiles={currentFile ? [currentFile] : []}
        isBlocked={!!pendingPermission}
        waitingPermission={!!pendingPermission}
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
