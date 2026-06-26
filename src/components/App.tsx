// Main App component — real agent integration with streaming
//
// This wires together:
//   - Agent system (code/plan/review agents with tool calling)
//   - Streaming display (text + tool blocks in real-time)
//   - Permission prompts (approve/deny tool execution)
//   - Slash commands (/help, /agent, /clear, /model, /compact)
//   - Token tracking

import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import ChatPanel from "./ChatPanel.js";
import CommandPicker, { filterCommands } from "./CommandPicker.js";
import type { CommandDef } from "./CommandPicker.js";
import ShortcutOverlay from "./ShortcutOverlay.js";
import SessionPicker from "./SessionPicker.js";
import StatusBar from "./StatusBar.js";
import TextInput from "./TextInput.js";
import PermissionPrompt from "./PermissionPrompt.js";
import QueuePreview from "./QueuePreview.js";
import { agentManager } from "../services/agent/index.js";
import { createModel } from "../services/provider/registry.js";
import { query } from "../services/query.js";
import { getOrCreateMemorySession, resetMemorySession } from "../services/agent/agentSession.js";
import os from "node:os";
import { TokenTracker } from "../services/tokenTracker.js";
import { ContextManager } from "../services/contextManager.js";
import { getToolDescriptions } from "../tools.js";
import type {
  Message,
  ToolUseBlock,
  QueryEvent,
  AgentEvent,
  AgentName,
  ProviderConfig,
  ProviderType,
  DeepSeekCodeConfig,
  ThinkingMode,
  MCPServerConfig,
  MessageBlock,
} from "../types/index.js";
import {
  saveSettings,
  saveSession,
  updateSession,
  loadSession,
  listSessions,
  pruneSessions,
} from "../state/storage.js";
import SettingsPanel from "./SettingsPanel.js";
import type { TabType } from "./SettingsPanel.js";
import { recordSessionStats } from "../state/stats.js";

// ── Thinking mode constants ───────────────────────────────────────────────

export default function App({ config, workingDirectory, resumeSessionHash: cliResumeHash }: { config: DeepSeekCodeConfig; workingDirectory: string; resumeSessionHash?: string }) {
  const { exit } = useApp();

  // ── State ─────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingToolUse, setStreamingToolUse] = useState<ToolUseBlock[]>([]);
  const [streamingBlocks, setStreamingBlocks] = useState<MessageBlock[]>([]);
  const [currentAgent, setCurrentAgent] = useState<AgentName>(config.defaultAgent || "code");
  const [tokenCount, setTokenCount] = useState(0);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [cost, setCost] = useState(0);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<{
    toolName: string;
    description: string;
    resolve: (decision: { approved: boolean; feedback?: string }) => void;
  } | null>(null);
  const [sessionAllowAll, setSessionAllowAll] = useState(false);

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

  // ── Tool Inspection Mode ──────────────────────────────────────────────
  const [inspectMode, setInspectMode] = useState(false);
  const [inspectIndex, setInspectIndex] = useState(0);
  const [isTranscriptMode, setIsTranscriptMode] = useState(false);

  // ── Session Picker Mode (ctrl+a) ──────────────────────────────────────
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [sessionPickerIndex, setSessionPickerIndex] = useState(0);
  const [sessionsList, setSessionsList] = useState<any[]>([]);

  // ── Stats Tracking State & Refs ──────────────────────────────────────
  const sessionStartMs = useRef(Date.now());
  const [apiDurationMs, setApiDurationMs] = useState(0);
  const [sessionLinesAdded, setSessionLinesAdded] = useState(0);
  const [sessionLinesRemoved, setSessionLinesRemoved] = useState(0);
  const [showSettingsOverlay, setShowSettingsOverlay] = useState(false);
  const [settingsOverlayTab, setSettingsOverlayTab] = useState<TabType>("usage");

  const getFlatToolBlocks = useCallback(() => {
    const flat: Array<{ messageIdx: number; toolIdx: number; block: ToolUseBlock }> = [];
    messages.forEach((msg, messageIdx) => {
      if (msg.toolUse) {
        msg.toolUse.forEach((block, toolIdx) => {
          flat.push({ messageIdx, toolIdx, block });
        });
      }
    });
    return flat;
  }, [messages]);

  const flatBlocks = getFlatToolBlocks();
  const selectedBlock = flatBlocks[inspectIndex];
  const selectedToolCallId = (inspectMode && selectedBlock) ? selectedBlock.block.toolCallId || null : null;

  useEffect(() => {
    const flatCount = getFlatToolBlocks().length;
    if (flatCount === 0) {
      setInspectMode(false);
      setInspectIndex(0);
    } else if (inspectIndex >= flatCount) {
      setInspectIndex(Math.max(0, flatCount - 1));
    }
  }, [messages, inspectIndex, getFlatToolBlocks]);

  // MCP runtime state (loaded from config)
  const [mcpServers, setMcpServers] = useState<Record<string, MCPServerConfig>>(
    config.mcpServers || {},
  );

  const abortRef = useRef<AbortController | null>(null);
  const lastSubmittedPromptRef = useRef("");
  const lastEscTimeRef = useRef(0);
  const lastCtrlCTimeRef = useRef(0);
  const tokenTrackerRef = useRef(new TokenTracker(activeModel));
  const contextManagerRef = useRef(new ContextManager(activeModel));
  /** Lets handleSubmit know the picker is intercepting Enter */
  const pickerActiveRef = useRef(false);
  /** Ref to handleSubmit so useInput can call it without stale closure */
  const handleSubmitRef = useRef<(overrideInput?: string) => void>(() => {});

  const streamingTextRef = useRef("");
  const streamingThinkingRef = useRef("");
  const streamingToolUseRef = useRef<ToolUseBlock[]>([]);
  const streamingBlocksRef = useRef<MessageBlock[]>([]);

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
  const showCommandPicker = filteredCommands.length > 0 && !isExactCommandMatch && !input.includes("\n");
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

      let currentHash = activeSessionHash;
      if (currentHash) {
        updateSession(currentHash, {
          messages: sessionMessages,
          tokenUsage: tokenCount,
        });
      } else {
        currentHash = saveSession({
          messages: sessionMessages,
          tokenUsage: tokenCount,
          model: activeModel,
          agent: currentAgent,
          workingDirectory,
        });
        setActiveSessionHash(currentHash);
        // Prune old sessions
        pruneSessions(50);
      }

      // Sync to global stats.json
      const record = {
        id: currentHash,
        name: workingDirectory.split("/").pop() || "session",
        cwd: workingDirectory,
        model: activeModel,
        createdAt: sessionStartMs.current,
        updatedAt: Date.now(),
        apiDurationMs,
        wallDurationMs: Date.now() - sessionStartMs.current,
        linesAdded: sessionLinesAdded,
        linesRemoved: sessionLinesRemoved,
        tokens: {
          input: tokenCount,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        cost,
      };
      recordSessionStats(record);
    } catch {
      // Best-effort
    }
  }, [messages.length, tokenCount, cost, apiDurationMs, sessionLinesAdded, sessionLinesRemoved]);

  // ── Resume session ONLY when --resume <hash> is passed explicitly ────
  useEffect(() => {
    if (!cliResumeHash) return; // No --resume flag → fresh session
    try {
      let sessionHashToLoad = cliResumeHash;
      if (cliResumeHash === "latest") {
        const sessions = listSessions();
        // Find the latest session in the current directory
        const localSession = sessions.find((s) => s.workingDirectory === workingDirectory);
        if (localSession) {
          sessionHashToLoad = localSession.hash;
        } else {
          // If no local session, check the overall newest session
          const overallLatest = sessions[0];
          if (overallLatest) {
            if (overallLatest.workingDirectory !== workingDirectory) {
              const cmd = `cd ${overallLatest.workingDirectory} && deepseek-code --resume ${overallLatest.hash}`;
              try {
                const { execSync } = require("child_process");
                execSync(`echo "${cmd}" | pbcopy`);
              } catch {}
              process.stderr.write(`\nTo resume session ${overallLatest.hash}, change directory to the project folder:\n\n  ${cmd}\n\n(This command has been copied to your clipboard!)\n\n`);
              process.exit(0);
            } else {
              sessionHashToLoad = overallLatest.hash;
            }
          } else {
            // No sessions at all → starting fresh
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "No saved sessions found. Started a fresh session.", timestamp: Date.now() },
            ]);
            return;
          }
        }
      }

      const session = loadSession(sessionHashToLoad);
      if (session) {
        setMessages(session.messages.map((m) => ({
          ...m,
          toolUse: [],
        })));
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
    // Ctrl+C: quit (if not in transcript mode, otherwise exit transcript mode)
    if (key.ctrl && _input === "c") {
      if (isTranscriptMode) {
        setIsTranscriptMode(false);
        return;
      }
      if (showSessionPicker) {
        setShowSessionPicker(false);
        return;
      }
      if (showSettingsOverlay) {
        setShowSettingsOverlay(false);
        return;
      }

      const now = Date.now();
      if (isLoading) {
        // Interrupt on first Ctrl+C
        abortRef.current?.abort();
        lastCtrlCTimeRef.current = now;
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: "Generation interrupted. Press Ctrl+C again to exit.",
            timestamp: now,
          },
        ]);
      } else if (now - lastCtrlCTimeRef.current < 1500) {
        // Exit on second Ctrl+C within 1.5s
        exit();
      } else {
        lastCtrlCTimeRef.current = now;
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: "Press Ctrl+C again to exit.",
            timestamp: now,
          },
        ]);
      }
      return;
    }

    // Ctrl+A: toggle session picker
    if (key.ctrl && _input === "a") {
      if (showSessionPicker) {
        setShowSessionPicker(false);
      } else if (!isLoading) {
        const list = listSessions();
        setSessionsList(list);
        setSessionPickerIndex(0);
        setShowSessionPicker(true);
      }
      return;
    }

    // Handle keypresses while Session Picker is open
    if (showSessionPicker) {
      if (key.escape || _input === "q") {
        setShowSessionPicker(false);
        return;
      }
      if (key.upArrow) {
        setSessionPickerIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSessionPickerIndex((prev) => Math.min(sessionsList.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        const selected = sessionsList[sessionPickerIndex];
        if (selected) {
          if (selected.workingDirectory === workingDirectory) {
            // Resume in-place
            const session = loadSession(selected.hash);
            if (session) {
              setMessages(session.messages.map((m) => ({ ...m, toolUse: [] })));
              setTokenCount(session.tokenUsage);
              setActiveSessionHash(session.hash);
            }
            setShowSessionPicker(false);
          } else {
            // Exit and print/copy resume command
            const cmd = `cd ${selected.workingDirectory} && deepseek-code --resume ${selected.hash}`;
            try {
              const { execSync } = require("child_process");
              execSync(`echo "${cmd}" | pbcopy`);
            } catch {}
            console.log(`\nTo resume session ${selected.hash}, change directory to the project folder:\n\n  ${cmd}\n\n(This command has been copied to your clipboard!)`);
            process.exit(0);
          }
        }
        return;
      }
      return; // Eat other key inputs while in session picker mode
    }

    // Ctrl+O: toggle transcript mode (Claude Code style)
    if (key.ctrl && _input === "o") {
      setIsTranscriptMode((prev) => !prev);
      return;
    }

    // Escape or q exits transcript mode if active
    if (isTranscriptMode) {
      if (key.escape || _input === "q") {
        setIsTranscriptMode(false);
        return;
      }
      return; // Eat other key inputs while in transcript mode
    }

    // Ctrl+E: toggle inspect mode
    if (key.ctrl && _input === "e") {
      const flatCount = getFlatToolBlocks().length;
      if (flatCount > 0) {
        setInspectMode((prev) => {
          const next = !prev;
          if (next) {
            setInspectIndex(flatCount - 1); // Select last block by default
          }
          return next;
        });
      }
      return;
    }

    if (inspectMode) {
      if (key.escape || _input === "q") {
        setInspectMode(false);
        return;
      }
      if (key.upArrow) {
        setInspectIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setInspectIndex((prev) => Math.min(flatBlocks.length - 1, prev + 1));
        return;
      }
      if (key.return || _input === " ") {
        const selected = flatBlocks[inspectIndex];
        if (selected) {
          setMessages((prev) => {
            const next = [...prev];
            const msg = { ...next[selected.messageIdx]! };
            const toolUse = [...(msg.toolUse || [])];
            const target = { ...toolUse[selected.toolIdx]! };
            target.isExpanded = !target.isExpanded;
            toolUse[selected.toolIdx] = target;
            msg.toolUse = toolUse;
            next[selected.messageIdx] = msg;
            return next;
          });
        }
        return;
      }
      return; // Eat other key inputs while in inspect mode
    }

    // Ctrl+Q: clear queued prompts
    if (key.ctrl && _input === "q" && isLoading && queuedSubmissions.length > 0) {
      const count = queuedSubmissions.length;
      setQueuedSubmissions([]);
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Cleared ${count} queued prompt${count > 1 ? "s" : ""}.`, timestamp: Date.now() },
      ]);
      return;
    }

    // ? toggles shortcuts panel (only when input is empty, to avoid accidental popups while typing)
    if (_input === "?" && !isLoading && input.trim().length === 0 && !showCommandPicker) {
      setShowShortcuts((prev) => !prev);
      return;
    }

    // Escape: interrupt generation OR dismiss picker OR clear input on double press
    if (key.escape) {
      if (pendingPermission) {
        pendingPermission.resolve({ approved: false, feedback: "Cancelled with Esc" });
        setPendingPermission(null);
      } else if (isLoading) {
        abortRef.current?.abort();
        setIsLoading(false);
        streamingTextRef.current = "";
        streamingThinkingRef.current = "";
        streamingToolUseRef.current = [];
        setStreamingText("");
        setStreamingThinking("");
        setStreamingToolUse([]);
        setMessages((prev) => [
          ...prev,
          { role: "system", content: "Generation interrupted.", timestamp: Date.now() },
        ]);
        if (lastSubmittedPromptRef.current) {
          setInput(lastSubmittedPromptRef.current);
        }
      } else if (showCommandPicker) {
        setInput("");
        setCommandPickerIndex(0);
      } else if (showShortcuts) {
        setShowShortcuts(false);
      } else {
        // Double Escape check to clear the input prompt
        const now = Date.now();
        if (now - lastEscTimeRef.current < 500 && input.length > 0) {
          setInput("");
        }
        lastEscTimeRef.current = now;
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
          if (key.return && !cmd.usage) {
            // Enter on no-arg command → execute immediately
            handleSubmitRef.current(cmd.name);
            setInputResetKey((prev) => prev + 1);
          } else {
            // Tab, or Enter on command with args → autocomplete (fill usage template)
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
      if (config.dangerouslySkipPermissions || sessionAllowAll) {
        return Promise.resolve({ approved: true });
      }
      return new Promise((resolve) => {
        setPendingPermission({ toolName, description, resolve });
      });
    },
    [config.dangerouslySkipPermissions, sessionAllowAll],
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

  const handleToolResult = useCallback((toolName: string, input: any, output: string, isError: boolean) => {
    if (!isError && input && typeof input === "object") {
      if (toolName === "Edit") {
        const added = (input.new_string || "").split("\n").length;
        const removed = (input.old_string || "").split("\n").length;
        setSessionLinesAdded((prev) => prev + added);
        setSessionLinesRemoved((prev) => prev + removed);
      } else if (toolName === "Write") {
        const added = (input.content || "").split("\n").length;
        setSessionLinesAdded((prev) => prev + added);
      }
    }

    let nextToolUse: ToolUseBlock[] = [];
    setStreamingToolUse((prev) => {
      let bestIndex = -1;
      let maxScore = -1;

      for (let i = 0; i < prev.length; i++) {
        const block = prev[i]!;
        if (block.status !== "running") continue;
        if (block.toolName !== toolName) continue;

        let score = 1;
        try {
          const blockInput = typeof block.input === "string" ? JSON.parse(block.input) : block.input;
          if (blockInput && typeof blockInput === "object" && input && typeof input === "object") {
            let matches = 0;
            let totalKeys = 0;
            for (const key of Object.keys(input)) {
              totalKeys++;
              if (blockInput[key] === input[key]) {
                matches++;
              }
            }
            score += matches / (totalKeys || 1);
          }
        } catch {
          // ignore parsing error
        }

        if (score > maxScore) {
          maxScore = score;
          bestIndex = i;
        }
      }

      if (bestIndex === -1) {
        bestIndex = prev.findIndex((b) => b.status === "running" && b.toolName === toolName);
      }

      if (bestIndex === -1) return prev;

      const next = [...prev];
      const target = next[bestIndex]!;
      next[bestIndex] = {
        ...target,
        status: isError ? "error" : "done",
        output,
        isExpanded: isError || toolName === "Write" || toolName === "Edit",
      };
      nextToolUse = next;
      streamingToolUseRef.current = next;

      // Update chronological blocks ref & state
      const blockInListIdx = streamingBlocksRef.current.findIndex(
        (b) => b.type === "tool" && b.block?.toolName === toolName && b.block?.status === "running"
      );
      if (blockInListIdx !== -1) {
        streamingBlocksRef.current[blockInListIdx] = {
          type: "tool",
          block: next[bestIndex]!,
        };
        setStreamingBlocks([...streamingBlocksRef.current]);
      }

      return next;
    });

    // NOTE: Do NOT commit intermediate steps to <Static> mid-stream.
    // Accumulate everything in the streaming area; commit once at finish.
    // This eliminates the flicker from tool blocks jumping between the live
    // area and <Static> scrollback on every tool completion.
  }, []);

  // ── Process agent/query events ──────────────────────────────────────────────
  const processAgentStream = useCallback(
    async (events: AsyncGenerator<AgentEvent | QueryEvent>) => {
      // Reset refs before starting
      streamingTextRef.current = "";
      streamingThinkingRef.current = "";
      streamingToolUseRef.current = [];
      streamingBlocksRef.current = [];
      setStreamingBlocks([]);

      for await (const event of events) {
        switch (event.type) {
          case "thinking-delta":
            streamingThinkingRef.current += event.text;
            setStreamingThinking(streamingThinkingRef.current);
            await yieldToRenderer();
            break;

          case "text-delta":
            streamingTextRef.current += event.text;
            setStreamingText(streamingTextRef.current);

            // Update chronological blocks
            {
              const lastBlock = streamingBlocksRef.current[streamingBlocksRef.current.length - 1];
              if (lastBlock && lastBlock.type === "text") {
                lastBlock.content = (lastBlock.content || "") + event.text;
              } else {
                streamingBlocksRef.current.push({ type: "text", content: event.text });
              }
              setStreamingBlocks([...streamingBlocksRef.current]);
            }

            await yieldToRenderer();
            break;

          case "tool-call-start": {
            const block: ToolUseBlock = {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: formatToolInput(event.toolName, event.args),
              argsJson: "",
              status: "running",
            };
            streamingToolUseRef.current = [...streamingToolUseRef.current, block];
            setStreamingToolUse(streamingToolUseRef.current);

            // Update chronological blocks
            streamingBlocksRef.current.push({ type: "tool", block });
            setStreamingBlocks([...streamingBlocksRef.current]);

            const filePath = event.args?.file_path as string | undefined;
            if (filePath) {
              setCurrentFile(filePath);
            }
            break;
          }

          case "tool-call-delta": {
            const blockIdx = streamingToolUseRef.current.findIndex(
              (b) => b.toolCallId === event.toolCallId && b.status === "running"
            );
            if (blockIdx !== -1) {
              const block = streamingToolUseRef.current[blockIdx]!;
              const newArgsJson = (block.argsJson || "") + event.text;
              block.argsJson = newArgsJson;

              // Parse accumulated JSON arguments best-effort
              let parsedInput = "";
              try {
                const parsed = JSON.parse(newArgsJson);
                parsedInput = formatToolInput(event.toolName, parsed);
              } catch {
                // Try parsing basic fields from partial JSON string using regexes
                const pathMatch = newArgsJson.match(/"file_path"\s*:\s*"([^"]*)/);
                const path = pathMatch ? pathMatch[1] : "";
                
                if (event.toolName === "Read" || event.toolName === "Write" || event.toolName === "Edit") {
                  if (path) {
                    parsedInput = path;
                  }
                } else if (event.toolName === "Bash") {
                  const cmdMatch = newArgsJson.match(/"command"\s*:\s*"([^"]*)/);
                  if (cmdMatch && cmdMatch[1]) parsedInput = cmdMatch[1];
                }
              }

              if (parsedInput) {
                block.input = parsedInput;
                if (event.toolName === "Write" || event.toolName === "Edit" || event.toolName === "Read") {
                  setCurrentFile(parsedInput);
                }
              }
              
              setStreamingToolUse([...streamingToolUseRef.current]);

              // Update in chronological blocks
              const blockInList = streamingBlocksRef.current.find(
                (b) => b.type === "tool" && b.block?.toolCallId === event.toolCallId
              );
              if (blockInList && blockInList.block) {
                blockInList.block.input = block.input;
                blockInList.block.argsJson = block.argsJson;
              }
              setStreamingBlocks([...streamingBlocksRef.current]);

              await yieldToRenderer();
            }
            break;
          }

          case "tool-call-end": {
            const blockIdx = streamingToolUseRef.current.findIndex(
              (b) => b.toolCallId === event.toolCallId && b.status === "running"
            );
            if (blockIdx !== -1) {
              const block = streamingToolUseRef.current[blockIdx]!;
              try {
                const parsed = JSON.parse(block.argsJson || "{}");
                block.input = formatToolInput(event.toolName, parsed);
              } catch {
                // Keep the last input we set
              }
              setStreamingToolUse([...streamingToolUseRef.current]);

              // Update in chronological blocks
              const blockInList = streamingBlocksRef.current.find(
                (b) => b.type === "tool" && b.block?.toolCallId === event.toolCallId
              );
              if (blockInList && blockInList.block) {
                blockInList.block.input = block.input;
              }
              setStreamingBlocks([...streamingBlocksRef.current]);

              await yieldToRenderer();
            }
            break;
          }

          case "tool-call-result":
            // Managed via handleToolResult callback in real-time, skip stream event
            break;

          case "step-finish":
            break;

          case "token-usage":
            setTokenCount(event.usage.totalTokens);
            setInputTokens(event.usage.promptTokens);
            setOutputTokens(event.usage.completionTokens);
            break;

          case "compact":
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `📦 Context compacted: ${event.messagesBefore} → ${event.messagesAfter} messages (${event.reason})`,
                timestamp: Date.now(),
              },
            ]);
            break;

          case "finish":
            setTokenCount(event.usage.totalTokens); // Set (not add) — finish carries cumulative
            setInputTokens(event.usage.promptTokens);
            setOutputTokens(event.usage.completionTokens);
            if (event.cost) {
              const totalCost = event.cost.totalCost;
              setCost((prev) => prev + totalCost);
            }
            break;

          case "error": {
            const errorMsg: Message = {
              role: "assistant",
              content: event.error,
              timestamp: Date.now(),
              toolUse: streamingToolUseRef.current.length > 0 ? [...streamingToolUseRef.current] : undefined,
              thinking: streamingThinkingRef.current || undefined,
              blocks: streamingBlocksRef.current.length > 0 ? [...streamingBlocksRef.current] : undefined,
              isError: true,
            };
            setMessages((prev) => [...prev, errorMsg]);
            streamingTextRef.current = "";
            streamingThinkingRef.current = "";
            streamingToolUseRef.current = [];
            streamingBlocksRef.current = [];
            setStreamingText("");
            setStreamingThinking("");
            setStreamingToolUse([]);
            setStreamingBlocks([]);
            setIsLoading(false);
            return;
          }
        }
      }

      // Finalize the assistant message
      const remainingText = streamingTextRef.current;
      const remainingThinking = streamingThinkingRef.current;
      const remainingToolUse = streamingToolUseRef.current;
      const remainingBlocks = streamingBlocksRef.current;

      if (remainingText || remainingToolUse.length > 0 || remainingThinking) {
        const finalMessage: Message = {
          role: "assistant",
          content: remainingText,
          timestamp: Date.now(),
          toolUse: remainingToolUse.length > 0 ? [...remainingToolUse] : undefined,
          thinking: remainingThinking || undefined,
          blocks: remainingBlocks.length > 0 ? [...remainingBlocks] : undefined,
        };
        setMessages((prev) => [...prev, finalMessage]);
      }
      streamingTextRef.current = "";
      streamingThinkingRef.current = "";
      streamingToolUseRef.current = [];
      streamingBlocksRef.current = [];
      setStreamingText("");
      setStreamingThinking("");
      setStreamingToolUse([]);
      setStreamingBlocks([]);
      setIsLoading(false);
    },
    [activeModel],
  );

  const submitUserPrompt = useCallback(
    async (trimmedInput: string, promptOverride?: string) => {
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

      // Create abort controller for this run
      const abortController = new AbortController();
      abortRef.current = abortController;

      // Sync token tracker and context manager to current model
      tokenTrackerRef.current.setModel(activeModel);
      contextManagerRef.current.setModel(activeModel);

      try {
        const agentConfig = agentManager.getConfig(currentAgent);

        // C++ owns history + memory + compaction; session is persistent across turns.
        const { session } = getOrCreateMemorySession({
          providerConfig,
          agentConfig,
          workingDir: workingDirectory,
          memoryDir: `${os.homedir()}/.deepseek-code/memory`,
          maxContextTokens: 1_000_000, // DeepSeek v4: 1M context window
          requestPermission,
          mcpServers,
          abortController,
          onToolResult: handleToolResult,
          history: messages,
        });

        const startTime = Date.now();
        const events = query({
          session,
          config: agentConfig,
          userMessage: promptOverride !== undefined ? promptOverride : trimmedInput,
          workingDir: workingDirectory,
          abortController,
        });

        await processAgentStream(events);
        const duration = Date.now() - startTime;
        setApiDurationMs((prev) => prev + duration);
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
        abortRef.current = null;
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
                "  /queue               Show queued prompts",
                "  /queue clear         Clear all queued prompts",
                "  /shortcuts           Toggle shortcuts panel",
                "  /clear               Clear conversation history",
                "  /compact             Summarize conversation to save context",
                "  /doctor              Run diagnostics on git, network, and bindings",
                "  /commit              Create a git commit from changes",
                "  /pr                  Commit, push, and create a GitHub pull request",
                "  /copy                Copy last assistant response to clipboard",
                "  /diff                Show git diff of working directory changes",
                "  /history             Show message history numbers for rewinding",
                "  /rewind              Truncate conversation back to a message number",
                "  /tools               List available tools",
                "  /exit                Exit DeepSeek Code",
                "",
                "━━━ Agents ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                ...agents.map((a) =>
                  `  ${a.name === currentAgent ? "▸" : " "} ${a.name.padEnd(8)} ${a.description}`,
                ),
                "",
                "━━━ Tools (" + currentAgent + " agent) ━━━━━━━━━━━━━━━━━━",
                ...tools.map((t: {name: string; description: string}) => `  ${t.name.padEnd(8)} ${t.description}`),
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
                "  Ctrl+Q             Clear queued prompts",
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
          resetMemorySession();
          setSessionAllowAll(false);
          setTokenCount(0);
          setInputTokens(0);
          setOutputTokens(0);
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
                  .map((t: any) => {
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

        case "/queue": {
          const subCmd = parts[1]?.toLowerCase();
          if (subCmd === "clear") {
            const count = queuedSubmissions.length;
            setQueuedSubmissions([]);
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: count > 0
                  ? `Cleared ${count} queued prompt${count > 1 ? "s" : ""}.`
                  : "Queue is already empty.",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }
          if (queuedSubmissions.length === 0) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "Queue is empty.", timestamp: Date.now() },
            ]);
            return true;
          }
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: [
                `Queued prompts (${queuedSubmissions.length}):`,
                "",
                ...queuedSubmissions.map((q, i) => `  ${i + 1}. ${q.length > 80 ? q.slice(0, 79) + "…" : q}`),
                "",
                "Ctrl+Q or /queue clear to cancel all.",
              ].join("\n"),
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        case "/cost":
        case "/usage":
          setSettingsOverlayTab("usage");
          setShowSettingsOverlay(true);
          return true;

        case "/settings":
          setSettingsOverlayTab("settings");
          setShowSettingsOverlay(true);
          return true;

        case "/status":
          setSettingsOverlayTab("status");
          setShowSettingsOverlay(true);
          return true;

        case "/config":
          setSettingsOverlayTab("config");
          setShowSettingsOverlay(true);
          return true;

        case "/stats":
          setSettingsOverlayTab("stats");
          setShowSettingsOverlay(true);
          return true;

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
            resetMemorySession();
            setSessionAllowAll(false);
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

        // ── /commit ─────────────────────────────────────────────────────
        case "/commit": {
          const { execSync } = require("child_process");
          let isGit = false;
          try {
            execSync("git rev-parse --is-inside-work-tree", { cwd: workingDirectory, stdio: "ignore" });
            isGit = true;
          } catch {
            isGit = false;
          }

          if (!isGit) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: "Not a git repository (or git is not installed).",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          let gitStatus = "";
          let gitDiff = "";
          let gitBranch = "";
          let gitLog = "";
          try {
            gitStatus = execSync("git status", { cwd: workingDirectory }).toString();
            gitDiff = execSync("git diff HEAD", { cwd: workingDirectory }).toString();
            gitBranch = execSync("git branch --show-current", { cwd: workingDirectory }).toString();
            gitLog = execSync("git log --oneline -10", { cwd: workingDirectory }).toString();
          } catch (e) {
            // Safe fallback
          }

          const prompt = `## Context

- Current git status:
\`\`\`
${gitStatus}
\`\`\`

- Current git diff (staged and unstaged changes):
\`\`\`
${gitDiff}
\`\`\`

- Current branch: ${gitBranch.trim()}

- Recent commits:
\`\`\`
${gitLog}
\`\`\`

## Git Safety Protocol

- NEVER update the git config
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- CRITICAL: ALWAYS create NEW commits. NEVER use git commit --amend, unless the user explicitly requests it
- Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported

## Your task

Based on the above changes, create a git commit:

1. Analyze all staged changes and draft a commit message:
   - Summarize the nature of the changes (new feature, enhancement, bug fix, refactoring, test, docs, etc.)
   - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"

2. Stage relevant files and create the commit:
   - Use the Bash tool to run "git add" and "git commit -m '<message>'".
   - You can call multiple tools or run commands sequentially. Stage and commit in one go if possible.`;

          void submitUserPrompt("/commit", prompt);
          return true;
        }

        // ── /pr ─────────────────────────────────────────────────────────
        case "/pr": {
          const { execSync } = require("child_process");
          let isGit = false;
          try {
            execSync("git rev-parse --is-inside-work-tree", { cwd: workingDirectory, stdio: "ignore" });
            isGit = true;
          } catch {
            isGit = false;
          }

          if (!isGit) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: "Not a git repository (or git is not installed).",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          let gitStatus = "";
          let gitDiff = "";
          let gitBranch = "";
          let gitLog = "";
          let defaultBranch = "main";
          try {
            gitStatus = execSync("git status", { cwd: workingDirectory }).toString();
            gitDiff = execSync("git diff HEAD", { cwd: workingDirectory }).toString();
            gitBranch = execSync("git branch --show-current", { cwd: workingDirectory }).toString();
            gitLog = execSync("git log --oneline -10", { cwd: workingDirectory }).toString();
            try {
              defaultBranch = execSync("git symbol-ref refs/remotes/origin/HEAD --short", { cwd: workingDirectory }).toString().replace("origin/", "").trim();
            } catch {
              try {
                defaultBranch = execSync("git config init.defaultBranch", { cwd: workingDirectory }).toString().trim() || "main";
              } catch {}
            }
          } catch (e) {
            // Safe fallback
          }

          const prompt = `## Context

- Current git status:
\`\`\`
${gitStatus}
\`\`\`

- Current git diff (staged and unstaged changes):
\`\`\`
${gitDiff}
\`\`\`

- Current branch: ${gitBranch.trim()}

- Recent commits:
\`\`\`
${gitLog}
\`\`\`

## Git Safety Protocol

- NEVER update the git config
- NEVER run destructive/irreversible git commands (like push --force, hard reset, etc) unless the user explicitly requests them
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- Do not commit files that likely contain secrets (.env, credentials.json, etc)
- Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported

## Your task

Analyze all changes that will be included in the pull request, making sure to look at all relevant commits.

Based on the above changes:
1. Create a new branch if on ${defaultBranch} (use appropriate username/feature-name prefix)
2. Create a single commit with an appropriate message:
   - Use the Bash tool to run "git add" and "git commit -m '<message>'".
3. Push the branch to origin
4. Create a pull request using \`gh pr create\` (or tell the user if the gh CLI tool is missing):
   - Keep PR titles short (under 70 characters). Use the body for details.
   - Stage, commit, push, and create PR using the Bash tool.`;

          void submitUserPrompt("/pr", prompt);
          return true;
        }

        // ── /copy ───────────────────────────────────────────────────────
        case "/copy": {
          const assistantMsgs = messages.filter((m) => m.role === "assistant" && !m.isError && m.content);
          if (assistantMsgs.length === 0) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: "No assistant responses found to copy.",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          let N = 1;
          if (arg) {
            N = parseInt(arg, 10);
            if (isNaN(N) || N <= 0) {
              N = 1;
            }
          }

          if (N > assistantMsgs.length) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `Index too large. Only ${assistantMsgs.length} assistant responses available.`,
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          const targetMsg = assistantMsgs[assistantMsgs.length - N]!;
          const contentToCopy = targetMsg.content;

          try {
            const { execSync } = require("child_process");
            execSync("pbcopy", { input: contentToCopy });
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `✓ Copied assistant response to clipboard (${contentToCopy.length} characters, ${contentToCopy.split("\n").length} lines).`,
                timestamp: Date.now(),
              },
            ]);
          } catch (e) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `✗ Failed to copy to clipboard: ${(e as Error).message}`,
                timestamp: Date.now(),
              },
            ]);
          }
          return true;
        }

        // ── /diff ───────────────────────────────────────────────────────
        case "/diff": {
          const { execSync } = require("child_process");
          let isGit = false;
          try {
            execSync("git rev-parse --is-inside-work-tree", { cwd: workingDirectory, stdio: "ignore" });
            isGit = true;
          } catch {
            isGit = false;
          }

          if (!isGit) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: "Not a git repository (or git is not installed).",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          try {
            const diffOutput = execSync("git diff", { cwd: workingDirectory }).toString();
            if (!diffOutput.trim()) {
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content: "No changes in the working directory (git diff is empty).",
                  timestamp: Date.now(),
                },
              ]);
            } else {
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content: [
                    "━━━ Git Changes (Working Directory) ━━━━━━━━━━━━━━",
                    diffOutput,
                  ].join("\n"),
                  timestamp: Date.now(),
                },
              ]);
            }
          } catch (e) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `✗ Failed to get git diff: ${(e as Error).message}`,
                timestamp: Date.now(),
              },
            ]);
          }
          return true;
        }

        // ── /history ────────────────────────────────────────────────────
        case "/messages":
        case "/history": {
          const lines = messages.map((m, i) => {
            const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "";
            const contentPreview = m.content.split("\n")[0] || "";
            const truncated = contentPreview.length > 60 ? contentPreview.slice(0, 59) + "…" : contentPreview;
            return `  [${i + 1}] ${m.role.padEnd(9)} | ${time.padEnd(10)} | ${truncated}`;
          });
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: [
                "━━━ Chat Message History ━━━━━━━━━━━━━━━━━━━━━━━━",
                ...lines,
                "",
                "Use /rewind <number> to truncate the history back to that message.",
              ].join("\n"),
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        // ── /rewind ─────────────────────────────────────────────────────
        case "/rewind": {
          if (!arg) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: "Usage: /rewind <message-number>\n\nUse /history to view message numbers.",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }
          const idx = parseInt(arg, 10) - 1;
          if (isNaN(idx) || idx < 0 || idx >= messages.length) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `Invalid message number: ${arg}. Must be between 1 and ${messages.length}.`,
                timestamp: Date.now(),
              },
            ]);
            return true;
          }
          const truncated = messages.slice(0, idx + 1);
          setMessages(truncated);
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `✓ Rewound conversation back to message #${idx + 1}.`,
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        // ── /doctor ─────────────────────────────────────────────────────
        case "/doctor": {
          const lines: string[] = ["━━━ DeepSeek Code Diagnostic (Doctor) ━━━━━━━━━━━━", ""];

          // 1. Check Bun/Node version
          const isBun = typeof Bun !== "undefined";
          lines.push(`  ${isBun ? "✓" : "✓"} Runtime:      ${isBun ? `Bun v${Bun.version}` : `Node ${process.version}`}`);

          // 2. Check native C++ bindings
          let bindingsOk = false;
          let bindingsError = "";
          try {
            const { getOrCreateMemorySession } = require("ai-sdk-cpp");
            bindingsOk = typeof getOrCreateMemorySession === "function";
          } catch (e) {
            bindingsError = (e as Error).message;
          }
          lines.push(`  ${bindingsOk ? "✓" : "✗"} C++ Native:   ${bindingsOk ? "Loaded successfully" : `Failed to load: ${bindingsError}`}`);

          // 3. Check Git installation
          let gitOk = false;
          let gitVersion = "";
          try {
            const { execSync } = require("child_process");
            gitVersion = execSync("git --version").toString().trim();
            gitOk = true;
          } catch {
            gitOk = false;
          }
          lines.push(`  ${gitOk ? "✓" : "✗"} Git CLI:      ${gitOk ? gitVersion : "Not found or not executable"}`);

          // 4. Check Config
          const keySet = !!activeApiKey;
          lines.push(`  ${keySet ? "✓" : "⚠"} API Key:      ${keySet ? `Configured (${activeApiKey.slice(0, 8)}…${activeApiKey.slice(-4)})` : "Not set (set with /setup or /apikey)"}`);
          lines.push(`  ✓ Active Model: ${activeProvider}/${activeModel}`);

          // Initial render before network check
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: lines.join("\n") + "\n\n  Checking network connection...",
              timestamp: Date.now(),
            },
          ]);

          // Asynchronously test network so we don't freeze the TUI
          setTimeout(async () => {
            let connOk = false;
            let timeMs = 0;
            const start = Date.now();
            try {
              const targetUrl = activeBaseURL || "https://api.deepseek.com/v1";
              const controller = new AbortController();
              const id = setTimeout(() => controller.abort(), 3000);
              await fetch(targetUrl, { signal: controller.signal }).catch(() => {});
              clearTimeout(id);
              timeMs = Date.now() - start;
              connOk = true;
            } catch {
              connOk = false;
            }

            setMessages((prev) => {
              const newLines = [...lines];
              newLines.push(`  ${connOk ? "✓" : "✗"} Network Connection: ${connOk ? `Connected to DeepSeek API endpoint (${timeMs}ms)` : "Failed to connect to DeepSeek API endpoint"}`);
              newLines.push("");
              newLines.push(connOk && bindingsOk && gitOk && keySet
                ? "  ✓ Everything looks healthy! You are ready to code."
                : "  ⚠ Diagnostics finished with warnings. Review the issues above.");

              const last = prev[prev.length - 1];
              if (last && last.role === "system" && last.content.includes("Diagnostic")) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: newLines.join("\n"), timestamp: Date.now() }
                ];
              }
              return [
                ...prev,
                { role: "system", content: newLines.join("\n"), timestamp: Date.now() }
              ];
            });
          }, 50);

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
      workingDirectory,
      submitUserPrompt,
    ],
  );

  // ── Submit handler ────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (overrideInput?: string) => {
    const rawInput = overrideInput !== undefined ? overrideInput : input;
    if (!rawInput.trim()) return;
    // Command picker is open — Enter selects a command, doesn't submit
    if (pickerActiveRef.current && overrideInput === undefined) return;

    const trimmedInput = rawInput.trim();
    if (!trimmedInput.startsWith("/")) {
      lastSubmittedPromptRef.current = trimmedInput;
    }
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
          selectedToolCallId={selectedToolCallId}
          streamingBlocks={streamingBlocks}
          isTranscriptMode={isTranscriptMode}
        />
      </Box>

      {/* Permission prompt overlay */}
      {pendingPermission && (
        <PermissionPrompt
          toolName={pendingPermission.toolName}
          description={pendingPermission.description}
          onApprove={(feedback) => {
            if (feedback === "__allow_all__") {
              setSessionAllowAll(true);
            }
            pendingPermission.resolve({ approved: true, feedback });
            setPendingPermission(null);
          }}
          onDeny={(feedback) => {
            pendingPermission.resolve({ approved: false, feedback });
            setPendingPermission(null);
          }}
        />
      )}

      {showSessionPicker ? (
        <SessionPicker
          sessions={sessionsList}
          selectedIndex={sessionPickerIndex}
          currentDirectory={workingDirectory}
        />
      ) : showSettingsOverlay ? (
        <SettingsPanel
          onClose={() => setShowSettingsOverlay(false)}
          config={config}
          workingDirectory={workingDirectory}
          activeModel={activeModel}
          activeProvider={activeProvider}
          activeApiKey={activeApiKey}
          activeBaseURL={activeBaseURL}
          tokenCount={tokenCount}
          cost={cost}
          apiDurationMs={apiDurationMs}
          sessionStartMs={sessionStartMs.current}
          linesAdded={sessionLinesAdded}
          linesRemoved={sessionLinesRemoved}
          mcpCount={mcpEnabledCount}
          sessionId={activeSessionHash || "new-session"}
          initialTab={settingsOverlayTab}
        />
      ) : isTranscriptMode ? (
        /* Transcript mode footer matching Claude Code */
        <Box
          borderStyle="single"
          borderTop={true}
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderDimColor
          paddingLeft={2}
          paddingRight={2}
          width="100%"
          height={3}
          alignItems="center"
        >
          <Text dimColor>
            Showing detailed transcript · <Text bold color="cyan">ctrl+o</Text> or <Text bold color="cyan">esc</Text> or <Text bold color="cyan">q</Text> to exit
          </Text>
        </Box>
      ) : (
        /* Normal mode elements */
        <>
          {/* Shortcut/options panel */}
          {showShortcuts && (
            <ShortcutOverlay
              thinkingMode={thinkingMode}
              mcpCount={mcpCount}
              mcpEnabledCount={mcpEnabledCount}
            />
          )}

          {/* Queue preview */}
          {queuedSubmissions.length > 0 && (
            <QueuePreview queueItems={queuedSubmissions} />
          )}

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
            queueCount={queuedSubmissions.length}
            isPickerActive={showCommandPicker}
          />

          {/* Status bar */}
          <StatusBar
            model={activeModel}
            agentName={currentAgent}
            tokenCount={tokenCount}
            inputTokens={inputTokens}
            outputTokens={outputTokens}
            thinkingMode={thinkingMode}
            mcpEnabledCount={mcpEnabledCount}
            queueCount={queuedSubmissions.length}
            queuePreview={queuedSubmissions[0]}
            currentFile={currentFile}
            awaitingPermission={!!pendingPermission}
            cost={cost}
            inspectMode={inspectMode}
          />
        </>
      )}
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
