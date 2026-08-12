// Main App component — real agent integration with streaming
//
// This wires together:
//   - Agent system (code/plan/review agents with tool calling)
//   - Streaming display (text + tool blocks in real-time)
//   - Permission prompts (approve/deny tool execution)
//   - Slash commands (/help, /agent, /clear, /model, /compact)
//   - Token tracking

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import ChatPanel from "./ChatPanel.js";
import CommandPicker, { filterCommands, ALL_COMMANDS } from "./CommandPicker.js";
import type { CommandDef } from "./CommandPicker.js";
import ShortcutOverlay from "./ShortcutOverlay.js";
import SessionPicker from "./SessionPicker.js";
import StatusBar from "./StatusBar.js";
import TextInput from "./TextInput.js";
import PermissionPrompt from "./PermissionPrompt.js";
import QueuePreview from "./QueuePreview.js";
import HelpView from "./HelpView.js";
import ExportView from "./ExportView.js";
import type { ExportFormat } from "../utils/exportConversation.js";
import SearchResultsView from "./SearchResultsView.js";
import type { SearchMatch } from "../utils/transcriptSearch.js";
import { ThemeProvider } from "../ui/design-system/ThemeProvider.js";
import { resolveThemeSetting, type ThemeSetting } from "../utils/theme.js";
import Onboarding, { type ThemeChoice } from "./Onboarding.js";
import EffortCallout from "./EffortCallout.js";
import ThemePicker from "./ThemePicker.js";
import { isTrusted } from "../services/projectTrust.js";
import { agentManager } from "../services/agent/index.js";
import { createModel } from "../services/provider/registry.js";
import { query } from "../services/query.js";
import { getOrCreateMemorySession, resetMemorySession } from "../services/agent/agentSession.js";
import os from "node:os";
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { listOutputStyles } from "../services/outputStyles.js";
import { listTasks } from "../services/tasks/backgroundFramework.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
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
  TodoItem,
} from "../types/index.js";
import {
  saveSettings,
  loadSettings,
  loadHistory,
  appendHistory,
  saveSession,
  updateSession,
  loadSession,
  listSessions,
  pruneSessions,
  pruneOldSessions,
} from "../state/storage.js";
import SettingsPanel from "./SettingsPanel.js";
import type { TabType } from "./SettingsPanel.js";
import { Settings } from "./Settings/Settings.js";
import { recordSessionStats } from "../state/stats.js";
import { loadHooks, runHooksFireAndForget } from "../services/hooks.js";
import {
  loadCustomCommands,
  renderCommand,
  toCommandDefs,
  type CustomCommand,
} from "../services/customCommands.js";
import PluginPanel from "./PluginPanel.js";
import { loadInstalledPlugins } from "../services/pluginService.js";
import { shutdownLspServerManager } from "../services/lsp/manager.js";
import TodoList from "./TodoList.js";
import HistorySearch from "./HistorySearch.js";
import FileMentions from "./FileMentions.js";
import { buildFileIndex } from "../utils/fileIndex.js";
import { fuzzyFilter, detectTrailingMention } from "../utils/fuzzy.js";
import { getEffortLevel, isEffortLevel } from "../services/effort.js";
import type { EffortLevel } from "../state/storage.js";
import { listSkills, getSkill } from "../skills/skillService.js";
import { writeToFile } from "../utils/exportConversation.js";
import { searchMessages } from "../utils/transcriptSearch.js";
import { snapshotFiles, restoreSnapshot, hasSnapshot, dropSnapshot } from "../utils/fileHistory.js";
import { notify, preventSleep, allowSleep } from "../utils/notify.js";
import { classifyError, resolveFallbackProvider, promptTooLongMessage, overloadMessage } from "../services/recovery.js";

// ── Thinking mode constants ───────────────────────────────────────────────

export default function App({ config, workingDirectory, resumeSessionHash: cliResumeHash }: { config: DeepSeekCodeConfig; workingDirectory: string; resumeSessionHash?: string }) {
  const { exit } = useApp();
  const handleExit = useCallback(() => {
    // Fire-and-forget LSP shutdown so configured language server processes
    // aren't orphaned on exit. Never throws; the 50ms exit window may cut it
    // short, in which case process exit reaps the children anyway.
    void shutdownLspServerManager();
    exit();
    setTimeout(() => {
      process.exit(0);
    }, 50);
  }, [exit]);

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

  // ── Reasoning effort (StatusBar chip + persisted setting) ─────────────
  // Initialized from getEffortLevel() (CLI > persisted settings > unset);
  // /effort <level> updates both the state (immediate chip refresh) and the
  // persisted setting. NOTE: if a CLI --effort flag is active it wins over
  // the persisted value in getEffortLevel() — the chip may then show the
  // command-set value while the session uses the CLI value.
  const [effortLevel, setEffortLevel] = useState<EffortLevel | undefined>(() => {
    try {
      return getEffortLevel();
    } catch {
      return undefined;
    }
  });

  const [commandPickerIndex, setCommandPickerIndex] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
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

  // ── Tabbed Settings UI (/config · /status · /usage) ───────────────────
  const [showSettingsUI, setShowSettingsUI] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"Status" | "Config" | "Usage">("Status");

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

  // Cleanup throttle timer on unmount
  useEffect(() => {
    return () => {
      if (outputThrottleTimerRef.current) {
        clearTimeout(outputThrottleTimerRef.current);
      }
    };
  }, []);

  // Keep the committed message count in a ref so callbacks that are recreated
  // rarely (processAgentStream, submitUserPrompt internals) can compute the
  // current 1-based message index without stale closures.
  useEffect(() => {
    messagesLenRef.current = messages.length;
  }, [messages.length]);

  // Sleep prevention: hold a caffeinate assertion while a turn is running so
  // long generations don't let the machine idle-sleep, release it when idle.
  // Ref-counted + defensive — never throws, no-op off macOS.
  useEffect(() => {
    try {
      if (isLoading) {
        preventSleep();
      } else {
        allowSleep();
      }
    } catch {
      // best-effort — sleep management must never break the chat loop
    }
  }, [isLoading]);

  // ── Terminal resize handler ──────────────────────────────────────────
  // Forces a React re-render on terminal resize so components reading
  // process.stdout.columns get the updated value.
  // Debounced: resize events fire rapidly during a drag; we batch them
  // to a single render to avoid flickering from intermediate states.
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setResizeTick((t) => t + 1);
      }, 50); // debounce 50ms — coalesces rapid resize events
    };
    process.stdout.on("resize", handler);
    return () => {
      process.stdout.off("resize", handler);
      if (timer) clearTimeout(timer);
    };
  }, []);
  // Reference resizeTick to force re-render — value itself unused
  void resizeTick;

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
  const streamingToolUseRef = useRef<ToolUseBlock[]>([]);
  const streamingBlocksRef = useRef<MessageBlock[]>([]);
  /** The in-progress thinking block (between thinking-start and thinking-end). */
  const thinkingOpenRef = useRef<MessageBlock | null>(null);
  const pendingOutputsRef = useRef<Record<string, string>>({});
  const outputThrottleTimerRef = useRef<NodeJS.Timeout | null>(null);

  /** Current committed message count (effect-synced — avoids stale closures). */
  const messagesLenRef = useRef(0);
  /** Absolute paths touched by file-mutating tools (Write/Edit/NotebookEdit),
   *  cumulative across turns — feeds /rewind file snapshots. */
  const touchedFilesRef = useRef<Set<string>>(new Set());
  /** Epoch ms when the current user turn started — drives the finish notify rule. */
  const turnStartRef = useRef(0);
  /** One-shot overload-recovery guard: never retry more than once per turn. */
  const recoveryAttemptedRef = useRef(false);
  /** Set by processAgentStream's error case when a fallback retry is armed. */
  const retryFallbackRef = useRef<ProviderConfig | null>(null);

  // Dirty flags — track which refs actually changed since the last flush so
  // we don't setState with fresh (but identical) array references every tick.
  // Without this, the flush creates new [...array] references every 80ms even
  // when only text changed, forcing a full React reconcile + Ink diff for
  // arrays that are logically identical — a major CPU drain during streaming.
  const flushDirtyRef = useRef({ text: false, blocks: false, toolUse: false });

  // Batch streaming text/thinking/blocks state updates into an ~80ms flush so
  // fast token streams don't re-render (and flicker) on every token.
  const streamingFlushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const scheduleStreamingFlush = useCallback(() => {
    if (streamingFlushTimerRef.current) return;
    streamingFlushTimerRef.current = setTimeout(() => {
      streamingFlushTimerRef.current = null;
      const dirty = flushDirtyRef.current;
      if (dirty.text) setStreamingText(streamingTextRef.current);
      if (dirty.blocks) setStreamingBlocks([...streamingBlocksRef.current]);
      if (dirty.toolUse) setStreamingToolUse([...streamingToolUseRef.current]);
      flushDirtyRef.current = { text: false, blocks: false, toolUse: false };
    }, 80);
  }, []);

  // ── Session state ────────────────────────────────────────────────────
  const [activeSessionHash, setActiveSessionHash] = useState<string | null>(null);

  // ── Theme / Settings states ──────────────────────────────────────────
  const [themeMode, setThemeModeState] = useState<ThemeSetting>(() => {
    try {
      const settings = loadSettings();
      return settings.themeMode || "dark";
    } catch {
      return "dark";
    }
  });

  // ── Pinned bottom bar (Claude Code REPL parity) ──────────────────────
  // The reference REPL wraps everything in an <AlternateScreen>'s
  // <Box height={rows}> so its ScrollBox flexGrow has a ceiling and the
  // bottom slot (input + status line, flexShrink={0}) never moves. Stock
  // ink gets the same with a terminal-height root box: messages flexGrow
  // in the middle, the input/status bar pins to the last rows.
  const { stdout } = useStdout();
  const [termRows, setTermRows] = useState<number>(() => stdout?.rows ?? process.stdout.rows ?? 40);
  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    const onResize = () => setTermRows(stdout.rows ?? termRows);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, termRows]);

  // ── Theme picker overlay (Claude Code parity: /theme opens the same
  // interactive ThemePicker as the first-time setup) ────────────────────
  const [showThemePicker, setShowThemePicker] = useState(false);

  // ── Effort selector callout (Claude Code parity: /effort with no args
  // opens the interactive EffortCallout dialog) ─────────────────────────
  const [showEffortCallout, setShowEffortCallout] = useState(false);
  const handleEffortCalloutDone = useCallback((selection: EffortLevel | "dismiss") => {
    setShowEffortCallout(false);
    if (selection === "dismiss") return;
    const EFFORT_DESCRIPTIONS: Record<string, string> = {
      low: "Quick, straightforward implementation",
      medium: "Balanced approach with standard testing",
      high: "Comprehensive implementation with extensive testing",
      max: "Maximum capability with deepest reasoning",
    };
    try {
      saveSettings({ effort: selection });
    } catch {}
    setEffortLevel(selection);
    setMessages((prev) => [
      ...prev,
      {
        role: "system",
        content: `Set effort level to ${selection}: ${EFFORT_DESCRIPTIONS[selection]}`,
        timestamp: Date.now(),
      },
    ]);
  }, []);

  // ── First-time setup (Claude Code parity: Onboarding) ────────────────
  // Shown on the very first run when no API key is configured. /setup and
  // /apikey remain available afterwards; finishing (or skipping) the flow
  // persists `onboarded` so it never reappears.
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    try {
      return !config.apiKey && !loadSettings().onboarded;
    } catch {
      return !config.apiKey;
    }
  });
  const handleOnboardingDone = useCallback(
    (result: { theme: ThemeChoice; apiKey?: string }) => {
      const { syncLiveTheme } = require("../utils/theme.js");
      syncLiveTheme(resolveThemeSetting(result.theme));
      setThemeModeState(result.theme);
      if (result.apiKey) {
        setActiveApiKey(result.apiKey);
      }
      try {
        saveSettings({ onboarded: true, themeMode: result.theme, apiKey: result.apiKey });
      } catch {
        // best-effort
      }
      setShowOnboarding(false);
    },
    [],
  );

  const [skipPermissions, setSkipPermissions] = useState(() => !!config.dangerouslySkipPermissions);

  // Permission modes (cycled with Shift+Tab, like the reference TUI).
  const [permissionMode, setPermissionMode] = useState<"default" | "acceptEdits" | "plan" | "bypassPermissions">(
    config.dangerouslySkipPermissions ? "bypassPermissions" : "default",
  );
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;

  // Snapshot of all persisted settings (drives the Settings editor + behavior flags).
  const [settingsSnapshot, setSettingsSnapshot] = useState<Record<string, unknown>>(() => {
    try {
      return loadSettings() as Record<string, unknown>;
    } catch {
      return {};
    }
  });
  const handleUpdateSetting = useCallback((key: string, value: unknown) => {
    try {
      saveSettings({ [key]: value } as any);
      setSettingsSnapshot(loadSettings() as Record<string, unknown>);
    } catch {
      // best-effort
    }
  }, []);

  const handleThemeModeChange = useCallback((mode: ThemeSetting) => {
    const { syncLiveTheme } = require("../utils/theme.js");
    syncLiveTheme(resolveThemeSetting(mode));
    setThemeModeState(mode);
    try {
      saveSettings({ themeMode: mode });
    } catch {}
  }, []);

  const handleSkipPermissionsChange = useCallback((val: boolean) => {
    setSkipPermissions(val);
    config.dangerouslySkipPermissions = val;
    try {
      saveSettings({ dangerouslySkipPermissions: val } as any);
    } catch {}
  }, [config]);

  const handleThinkingModeChange = useCallback((mode: ThinkingMode) => {
    setThinkingMode(mode);
    try {
      saveSettings({ thinkingMode: mode } as any);
    } catch {}
  }, []);

  // ── Plugins state & integration ──────────────────────────────────────
  const [showPluginOverlay, setShowPluginOverlay] = useState(false);
  const [pluginCommands, setPluginCommands] = useState<CommandDef[]>([]);

  // ── Custom slash commands (markdown files) ────────────────────────────
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);

  // ── Live todo list (driven by the TodoWrite tool via onTodosChange) ────
  const [todos, setTodos] = useState<TodoItem[]>([]);
  // Tasks footer (Claude Code parity): the pill lives in the status footer;
  // ↓ expands the navigable list, Esc/Enter collapses it.
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [tasksSelectedIndex, setTasksSelectedIndex] = useState(0);

  // ── Prompt history search (Ctrl+R) + @-file mentions ─────────────────
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const [historySnapshot, setHistorySnapshot] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionSuppressed, setMentionSuppressed] = useState(false);
  const fileIndexRef = useRef<string[] | null>(null);

  // ── Ported Claude Code command surfaces ──────────────────────────────
  // /help → HelpView pane; /export → ExportView dialog; /search →
  // SearchResultsView overlay. Each owns its own keyboard handling while
  // open; App's useInput defers to them (see the overlay gate below).
  const [showHelp, setShowHelp] = useState(false);
  const [exportDialog, setExportDialog] = useState<{ defaultFormat: ExportFormat } | null>(null);
  const [searchResults, setSearchResults] = useState<{
    query: string;
    matches: SearchMatch[];
    total: number;
  } | null>(null);

  // ── Custom status line (Claude Code parity, /statusline) ─────────────
  // When settings.statusLine is set, run its command (trust-gated, 5s
  // timeout) and render the trimmed stdout right-aligned on the status bar.
  const [statusLineText, setStatusLineText] = useState<string | null>(null);
  const statusLineTextRef = useRef<string | null>(null);
  const statusLineAbortRef = useRef<AbortController | null>(null);
  const statusLineTimerRef = useRef<NodeJS.Timeout | null>(null);

  /** Current statusLine setting (re-read from the settings snapshot). */
  const statusLineSetting = (settingsSnapshot as { statusLine?: { type: "command"; command: string } })
    .statusLine;

  // Run the configured status-line command once, storing trimmed stdout.
  // SECURITY: like claude-code hooks, only executes in a trusted workspace
  // (isTrusted) — untrusted workspaces skip execution entirely.
  const runStatusLineCommand = useCallback(() => {
    if (statusLineTimerRef.current) {
      clearTimeout(statusLineTimerRef.current);
      statusLineTimerRef.current = null;
    }
    let setting: { type: string; command?: string } | undefined;
    try {
      setting = loadSettings().statusLine;
    } catch {
      setting = undefined;
    }
    if (!setting || setting.type !== "command" || !setting.command) {
      if (statusLineTextRef.current !== null) {
        statusLineTextRef.current = null;
        setStatusLineText(null);
      }
      return;
    }
    const command = setting.command;
    if (!isTrusted(workingDirectory)) return; // trust gate — never run untrusted
    statusLineAbortRef.current?.abort(); // cancel any in-flight run
    const controller = new AbortController();
    statusLineAbortRef.current = controller;
    const killTimer = setTimeout(() => controller.abort(), 5000);
    void (async () => {
      try {
        const proc = Bun.spawn(["sh", "-c", command], {
          stdout: "pipe",
          stderr: "ignore",
          stdin: "ignore",
          signal: controller.signal,
          cwd: workingDirectory,
        });
        const stdout = await new Response(proc.stdout).text();
        clearTimeout(killTimer);
        if (controller.signal.aborted) return;
        const trimmed = stdout.trim();
        if (trimmed !== statusLineTextRef.current) {
          statusLineTextRef.current = trimmed;
          setStatusLineText(trimmed);
        }
      } catch {
        // A slow/failing status-line command must never crash the UI —
        // keep the previous output (or nothing), stay dim.
      }
    })();
  }, [workingDirectory]);

  // Debounced scheduling (300ms, like the reference) — coalesces rapid
  // triggers (turn finish + interval can land together).
  const scheduleStatusLineRun = useCallback(() => {
    if (statusLineTimerRef.current) clearTimeout(statusLineTimerRef.current);
    statusLineTimerRef.current = setTimeout(() => {
      statusLineTimerRef.current = null;
      runStatusLineCommand();
    }, 300);
  }, [runStatusLineCommand]);

  // Run once on mount, and whenever the configured command changes.
  useEffect(() => {
    runStatusLineCommand();
    return () => {
      statusLineAbortRef.current?.abort();
      if (statusLineTimerRef.current) clearTimeout(statusLineTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatusLineCommand, statusLineSetting]);

  // Refresh on a modest interval while configured (20s — cheap, keeps the
  // output fresh without hammering the command).
  useEffect(() => {
    if (!statusLineSetting) return;
    const id = setInterval(() => runStatusLineCommand(), 20_000);
    return () => clearInterval(id);
  }, [statusLineSetting, runStatusLineCommand]);

  // Refresh after each finished turn (isLoading edge true → false).
  const prevLoadingRef = useRef(isLoading);
  useEffect(() => {
    if (prevLoadingRef.current && !isLoading) scheduleStatusLineRun();
    prevLoadingRef.current = isLoading;
  }, [isLoading, scheduleStatusLineRun]);

  const refreshPlugins = useCallback(() => {
    try {
      const plugins = loadInstalledPlugins();
      const enabled = plugins.filter((p) => p.enabled);

      // Keep the picker clean (Claude Code's slash menu): one-line
      // descriptions, no duplicates across plugins, and built-in commands
      // win over plugin skills with the same name.
      const seen = new Set(ALL_COMMANDS.map((c) => c.name));
      const truncate = (s: string, max = 70) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
      const cmds: CommandDef[] = [];
      for (const p of enabled) {
        if (p.manifest.commands) {
          for (const pcmd of p.manifest.commands) {
            const name = pcmd.name.startsWith("/") ? pcmd.name : `/${pcmd.name}`;
            if (seen.has(name)) continue;
            seen.add(name);
            cmds.push({
              name,
              description: truncate(pcmd.description ?? `Plugin command from ${p.name}`),
              usage: `${name} `,
              category: "session",
            });
          }
        }
        if (p.manifest.skills) {
          for (const skill of p.manifest.skills) {
            const name = skill.name.startsWith("/") ? skill.name : `/${skill.name}`;
            if (seen.has(name)) continue;
            seen.add(name);
            cmds.push({
              name,
              description: truncate(skill.description),
              usage: `${name} `,
              category: "session",
            });
          }
        }
      }
      setPluginCommands(cmds);

      const newMcp: Record<string, MCPServerConfig> = { ...config.mcpServers };
      for (const p of enabled) {
        if (p.manifest.mcpServers) {
          for (const [name, srv] of Object.entries(p.manifest.mcpServers)) {
            newMcp[name] = srv;
          }
        }
      }
      setMcpServers(newMcp);
    } catch {}
  }, [config.mcpServers]);

  useEffect(() => {
    refreshPlugins();
  }, [refreshPlugins]);

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
    themeMode?: "dark" | "light";
    dangerouslySkipPermissions?: boolean;
    thinkingMode?: string;
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
  const extraCommands = useMemo(
    () => [...pluginCommands, ...toCommandDefs(customCommands)],
    [pluginCommands, customCommands],
  );
  const filteredCommands: CommandDef[] = !isLoading ? filterCommands(input, extraCommands) : [];
  // Hide picker once the user has typed an exact command name (ready to press Enter)
  const isExactCommandMatch =
    filteredCommands.length === 1 && filteredCommands[0]?.name === input.trimEnd().toLowerCase();
  // Also hide once the first word is a complete command — the user has typed
  // "/effort " and is now typing the argument (Claude Code behavior: the
  // picker completes on space and gets out of the way).
  const firstWord = input.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const hasExactCommandPrefix =
    firstWord.length > 0 && filteredCommands.some((c) => c.name === firstWord);
  const showCommandPicker =
    filteredCommands.length > 0 && !isExactCommandMatch && !hasExactCommandPrefix && !input.includes("\n");
  // Keep ref in sync every render so handleSubmit can read it without stale closure
  pickerActiveRef.current = showCommandPicker;

  // ── @-file mention detection (trailing @query at the cursor / end) ────
  const mention = useMemo(
    () => (isLoading || showCommandPicker ? null : detectTrailingMention(input)),
    [input, isLoading, showCommandPicker],
  );
  const mentionMatches = useMemo(() => {
    if (!mention || mentionSuppressed) return [];

    // Support dynamic file/folder autocompletion for relative/absolute paths
    // (e.g. starting with . or .. or containing /)
    if (mention.query.includes("/") || mention.query.startsWith("..") || mention.query.startsWith(".")) {
      const lastSlashIdx = mention.query.lastIndexOf("/");
      let dirPath = "";
      let filePrefix = "";
      if (lastSlashIdx >= 0) {
        dirPath = mention.query.slice(0, lastSlashIdx + 1);
        filePrefix = mention.query.slice(lastSlashIdx + 1);
      } else {
        dirPath = mention.query;
        filePrefix = "";
      }

      const targetDir = resolve(workingDirectory, dirPath);
      try {
        const entries = readdirSync(targetDir, { withFileTypes: true });
        const matches = entries
          .filter((e) => {
            if (e.name.startsWith(".") && !filePrefix.startsWith(".")) return false;
            if (e.name === "node_modules") return false;
            return e.name.toLowerCase().startsWith(filePrefix.toLowerCase());
          })
          .map((e) => {
            const rel = dirPath ? `${dirPath}${e.name}` : e.name;
            return e.isDirectory() ? `${rel}/` : rel;
          })
          .slice(0, 8);
        return matches;
      } catch {
        return [];
      }
    }

    const idx = fileIndexRef.current ?? [];
    return fuzzyFilter(mention.query, idx, (s) => s, 8).map((r) => r.item);
  }, [mention, mentionSuppressed, workingDirectory]);
  useEffect(() => {
    setMentionIndex(0);
  }, [mention?.query]);

  // Load persisted prompt history + build the file index once on mount.
  useEffect(() => {
    try {
      inputHistory.current = loadHistory();
    } catch {
      // best-effort
    }
    try {
      fileIndexRef.current = buildFileIndex(workingDirectory);
    } catch {
      fileIndexRef.current = [];
    }
    try {
      setCustomCommands(loadCustomCommands(workingDirectory));
    } catch {
      // best-effort
    }
    // Prune sessions older than the configured cutoff (default 30 days).
    try {
      pruneOldSessions(loadSettings().cleanupPeriodDays ?? 30);
    } catch {
      // best-effort
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (showSettingsUI) {
        setShowSettingsUI(false);
        return;
      }
      if (showHelp) {
        setShowHelp(false);
        return;
      }
      if (exportDialog) {
        setExportDialog(null);
        return;
      }
      if (searchResults) {
        setSearchResults(null);
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
        handleExit();
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

    // Onboarding owns the keyboard while it's showing (it has its own
    // useInput handlers; ctrl+c above still quits).
    if (showOnboarding) {
      return;
    }

    // Full-screen overlays manage their own input — defer all other keys to them.
    if (showHistorySearch || showSettingsOverlay || showPluginOverlay || exportDialog || searchResults || showEffortCallout || showThemePicker) {
      return;
    }

    // The tabbed Settings UI owns its keyboard input, including Esc: the
    // Settings shell's handler calls onClose (Esc dismisses unless the Config
    // tab's search/edit submenu is open, where Config layers Esc itself —
    // clear query → exit search → close). Ink dispatches every key to all
    // handlers, so closing here too would fire on the same Esc and break that
    // layering (e.g. the first Esc in Config search would close the pane
    // instead of clearing the query). This mirrors the reference, where the
    // Settings pane binds confirm:no (Esc) itself.
    if (showSettingsUI) {
      return; // defer all other keys to the Settings UI
    }

    // Esc closes the /help pane (HelpView has no input handler of its own).
    if (showHelp) {
      if (key.escape) {
        setShowHelp(false);
        return;
      }
      return; // eat other keys while /help is open
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

    // Ctrl+O: toggle transcript mode (expands thinking/reasoning + all tool
    // blocks). Some terminals send Ctrl+O as the raw SI control char (\x0f)
    // without setting key.ctrl — accept both.
    if ((key.ctrl && _input === "o") || _input === "\x0f") {
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

    // Ctrl+R: fuzzy-search persisted prompt history
    if (key.ctrl && _input === "r" && !isLoading) {
      setHistorySnapshot(inputHistory.current);
      setShowHistorySearch(true);
      return;
    }

    // @-file mention: navigate / accept / dismiss while the dropdown is open
    if (mention && mentionMatches.length > 0) {
      const pick = () =>
        mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)] ?? mentionMatches[0]!;
      if (key.tab) {
        const value = input.slice(0, mention.atPos) + pick() + " ";
        setInput(value);
        setMentionIndex(0);
        setMentionSuppressed(false);
        return;
      }
      if (key.upArrow) {
        setMentionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setMentionIndex((i) => Math.min(mentionMatches.length - 1, i + 1));
        return;
      }
      if (key.escape) {
        setMentionSuppressed(true);
        return;
      }
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
        streamingToolUseRef.current = [];
        thinkingOpenRef.current = null;
        setStreamingText("");
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
          } else {
            // Tab, or Enter on command with args → autocomplete (fill usage template)
            setInput(cmd.usage ?? cmd.name);
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

    // Tasks panel (Claude Code footer parity): ↓ on an empty prompt expands
    // the task list; ↑/↓ navigates inside it; Esc/Enter collapses it back
    // into the footer pill.
    if (todos.length > 0 && !showCommandPicker && !isLoading) {
      if (tasksExpanded) {
        if (key.upArrow) {
          setTasksSelectedIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setTasksSelectedIndex((i) => Math.min(todos.length - 1, i + 1));
          return;
        }
        if (key.escape || key.return) {
          setTasksExpanded(false);
          return;
        }
      } else if (key.downArrow && input.trim().length === 0) {
        const activeIdx = todos.findIndex((t) => t.status === "in_progress");
        setTasksSelectedIndex(activeIdx >= 0 ? activeIdx : 0);
        setTasksExpanded(true);
        return;
      }
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
          }
        } else {
          // Bottom of history — clear input
          historyIndex.current = -1;
          setInput("");
        }
        return;
      }
    }

    // Shift+Tab: cycle permission mode (default → acceptEdits → plan → bypass)
    if (key.shift && key.tab) {
      setPermissionMode((prev) => {
        const order: ("default" | "acceptEdits" | "plan" | "bypassPermissions")[] = [
          "default", "acceptEdits", "plan", "bypassPermissions",
        ];
        const idx = order.indexOf(prev);
        return order[(idx + 1) % order.length]!;
      });
      return;
    }
  });

  // ── Permission callback ───────────────────────────────────────────────
  const requestPermission = useCallback(
    (toolName: string, description: string): Promise<{ approved: boolean; feedback?: string }> => {
      const mode = permissionModeRef.current;
      if (mode === "bypassPermissions" || sessionAllowAll) {
        return Promise.resolve({ approved: true });
      }
      if (mode === "plan") {
        return Promise.resolve({
          approved: false,
          feedback: "Plan mode is read-only. Press Shift+Tab to switch to a write-enabled mode.",
        });
      }
      if (mode === "acceptEdits" && ["Write", "Edit", "NotebookEdit"].includes(toolName)) {
        return Promise.resolve({ approved: true });
      }
      return new Promise((resolve) => {
        runHooksFireAndForget("Notification", {
          notification: `Permission required: ${toolName}`,
          tool: toolName,
          cwd: workingDirectory,
        });
        setPendingPermission({ toolName, description, resolve });
      });
    },
    [sessionAllowAll],
  );

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      if (showShortcuts && value.trim().length > 0) {
        setShowShortcuts(false);
      }
      // Re-enable mention suggestions once the @ token is closed (space) or removed.
      if (!detectTrailingMention(value)) {
        setMentionSuppressed(false);
      }
    },
    [showShortcuts],
  );

  const handleToolResult = useCallback((toolName: string, input: any, output: string, isError: boolean) => {
    if (!isError && input && typeof input === "object") {
      // Track file-mutating tool targets — the cumulative set feeds /rewind
      // file snapshots (snapshotFiles at the next turn start). Bash is
      // deliberately excluded: it can touch arbitrary paths.
      if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
        const fp = (input as { file_path?: unknown }).file_path;
        if (typeof fp === "string" && fp.length > 0) {
          try {
            touchedFilesRef.current.add(resolve(workingDirectory, fp));
          } catch {
            // best-effort — a bad path must never break the chat loop
          }
        }
      }
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
  }, [workingDirectory]);

  const handleToolOutput = useCallback((toolName: string, text: string) => {
    if (toolName !== "Bash") return; // Only bash streams live output

    // Append output text to the throttle buffer
    pendingOutputsRef.current[toolName] = (pendingOutputsRef.current[toolName] || "") + text;

    // Schedule state update if not already scheduled
    if (!outputThrottleTimerRef.current) {
      outputThrottleTimerRef.current = setTimeout(() => {
        outputThrottleTimerRef.current = null;

        // Flush buffer to state
        const flushed = pendingOutputsRef.current;
        pendingOutputsRef.current = {};

        setStreamingToolUse((prev) => {
          const runningIdx = prev.findIndex((b) => b.toolName === "Bash" && b.status === "running");
          if (runningIdx === -1) return prev;

          const next = [...prev];
          const block = next[runningIdx]!;
          const textToAppend = flushed["Bash"] || "";
          next[runningIdx] = {
            ...block,
            output: (block.output || "") + textToAppend,
          };
          streamingToolUseRef.current = next;

          // Update chronological blocks ref & state
          const blockInListIdx = streamingBlocksRef.current.findIndex(
            (b) => b.type === "tool" && b.block?.toolName === "Bash" && b.block?.status === "running"
          );
          if (blockInListIdx !== -1) {
            streamingBlocksRef.current[blockInListIdx] = {
              type: "tool",
              block: next[runningIdx]!,
            };
            setStreamingBlocks([...streamingBlocksRef.current]);
          }

          return next;
        });
      }, 100); // Throttle to at most 10 updates per second
    }
  }, []);

  // Live todo list — driven by the TodoWrite tool via onTodosChange.
  const handleTodosChange = useCallback((next: TodoItem[]) => {
    setTodos(next);
  }, []);

  // ── Process agent/query events ──────────────────────────────────────────────
  const processAgentStream = useCallback(
    async (events: AsyncGenerator<AgentEvent | QueryEvent>) => {
      // Reset refs before starting
      streamingTextRef.current = "";
      streamingToolUseRef.current = [];
      streamingBlocksRef.current = [];
      thinkingOpenRef.current = null;
      setStreamingBlocks([]);

      for await (const event of events) {
        switch (event.type) {
          case "thinking-start":
            // Open a chronological thinking block (rendered collapsed, like
            // Claude Code) — no longer hoisted above the whole turn.
            {
              const block: MessageBlock = { type: "thinking", content: "" };
              streamingBlocksRef.current.push(block);
              thinkingOpenRef.current = block;
              flushDirtyRef.current.blocks = true;
              scheduleStreamingFlush();
            }
            break;

          case "thinking-delta": {
            // Defensive: lazily open the block if a delta arrives without a
            // preceding start (older bindings / provider quirks).
            if (!thinkingOpenRef.current) {
              const block: MessageBlock = { type: "thinking", content: "" };
              streamingBlocksRef.current.push(block);
              thinkingOpenRef.current = block;
              flushDirtyRef.current.blocks = true;
            }
            thinkingOpenRef.current.content += event.text;
            flushDirtyRef.current.blocks = true;
            scheduleStreamingFlush();
            break;
          }

          case "thinking-end":
            thinkingOpenRef.current = null;
            flushDirtyRef.current.blocks = true;
            scheduleStreamingFlush();
            break;

          case "text-delta":
            streamingTextRef.current += event.text;
            flushDirtyRef.current.text = true;
            // Update chronological blocks (ref is source of truth; flush syncs state)
            {
              const lastBlock = streamingBlocksRef.current[streamingBlocksRef.current.length - 1];
              if (lastBlock && lastBlock.type === "text") {
                lastBlock.content = (lastBlock.content || "") + event.text;
              } else {
                streamingBlocksRef.current.push({ type: "text", content: event.text });
              }
              flushDirtyRef.current.blocks = true;
            }
            scheduleStreamingFlush();
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
            streamingBlocksRef.current.push({ type: "tool", block });
            flushDirtyRef.current.toolUse = true;
            flushDirtyRef.current.blocks = true;
            scheduleStreamingFlush();

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

              // Update in chronological blocks
              const blockInList = streamingBlocksRef.current.find(
                (b) => b.type === "tool" && b.block?.toolCallId === event.toolCallId
              );
              if (blockInList && blockInList.block) {
                blockInList.block.input = block.input;
                blockInList.block.argsJson = block.argsJson;
              }
              flushDirtyRef.current.toolUse = true;
              flushDirtyRef.current.blocks = true;
              scheduleStreamingFlush();
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

              // Update in chronological blocks
              const blockInList = streamingBlocksRef.current.find(
                (b) => b.type === "tool" && b.block?.toolCallId === event.toolCallId
              );
              if (blockInList && blockInList.block) {
                blockInList.block.input = block.input;
              }
              flushDirtyRef.current.toolUse = true;
              flushDirtyRef.current.blocks = true;
              scheduleStreamingFlush();
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
            // Feed the C++ reported usage into the context manager for tracking
            contextManagerRef.current.trackUsage(event.usage);
            // Warn user if approaching context limit
            if (contextManagerRef.current.shouldWarn()) {
              const pct = contextManagerRef.current.getUsagePercent();
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content: `⚠ Context at ${pct}% — approaching limit. Use /compact to free space or /clear to start fresh.`,
                  timestamp: Date.now(),
                },
              ]);
            }
            if (event.cost) {
              const totalCost = event.cost.totalCost;
              setCost((prev) => prev + totalCost);
            }
            // Finish notification rule (documented): the TUI has no
            // document-visibility API (Claude Code relies on document.hidden
            // in the webview), so we use the closest TUI analogue — notify on
            // finish ONLY when the turn took longer than 20s, i.e. the user
            // likely looked away. Short turns never notify (user is watching
            // the stream). Deliberately simple: no keybind, no state.
            if (turnStartRef.current > 0 && Date.now() - turnStartRef.current > 20_000) {
              void notify({ body: `Response ready (${activeModel})`, bell: true }).catch(() => {});
            }
            runHooksFireAndForget("Stop", { cwd: workingDirectory });
            break;

          case "error": {
            const errorText = event.error;
            const cls = classifyError(errorText);

            // ── Prompt too long (413 / "prompt is too long" / "maximum
            //    context length"): the C++ session owns compaction, so never
            //    attempt it TS-side. Surface the recovery commands instead.
            if (cls === "prompt-too-long") {
              setMessages((prev) => [
                ...prev,
                { role: "system", content: promptTooLongMessage(), timestamp: Date.now() },
              ]);
              streamingTextRef.current = "";
              streamingToolUseRef.current = [];
              streamingBlocksRef.current = [];
              thinkingOpenRef.current = null;
              setStreamingText("");
              setStreamingToolUse([]);
              setStreamingBlocks([]);
              setIsLoading(false);
              return;
            }

            // ── Overload (429): one-shot retry against a fallback provider.
            if (cls === "overload") {
              if (!recoveryAttemptedRef.current) {
                const fallback = resolveFallbackProvider(config, providerConfig);
                if (fallback) {
                  // Arm the retry; submitUserPrompt re-issues the same prompt
                  // after this stream returns. Keep isLoading=true so the
                  // retry renders as one continuous turn.
                  recoveryAttemptedRef.current = true;
                  retryFallbackRef.current = fallback;
                  streamingTextRef.current = "";
                  streamingToolUseRef.current = [];
                  streamingBlocksRef.current = [];
                  thinkingOpenRef.current = null;
                  setStreamingText("");
                  setStreamingToolUse([]);
                  setStreamingBlocks([]);
                  return;
                }
              }
              // No fallback configured, or already retried once → surface a
              // clear overload message with a retry hint.
              setMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: overloadMessage(activeModel),
                  timestamp: Date.now(),
                  isError: true,
                },
              ]);
              streamingTextRef.current = "";
              streamingToolUseRef.current = [];
              streamingBlocksRef.current = [];
              thinkingOpenRef.current = null;
              setStreamingText("");
              setStreamingToolUse([]);
              setStreamingBlocks([]);
              setIsLoading(false);
              return;
            }

            const errorMsg: Message = {
              role: "assistant",
              content: errorText,
              timestamp: Date.now(),
              toolUse: streamingToolUseRef.current.length > 0 ? [...streamingToolUseRef.current] : undefined,
              blocks: streamingBlocksRef.current.length > 0 ? [...streamingBlocksRef.current] : undefined,
              isError: true,
            };
            setMessages((prev) => [...prev, errorMsg]);
            streamingTextRef.current = "";
            streamingToolUseRef.current = [];
            streamingBlocksRef.current = [];
            thinkingOpenRef.current = null;
            setStreamingText("");
            setStreamingToolUse([]);
            setStreamingBlocks([]);
            setIsLoading(false);
            return;
          }
        }
      }

      // Finalize the assistant message. Drop any still-running tool blocks
      // (starts whose results never matched — e.g. concurrent same-tool calls)
      // so they don't leave empty ⏺ entries in the committed transcript.
      const remainingText = streamingTextRef.current;
      const remainingToolUse = streamingToolUseRef.current.filter(
        (b) => b.status !== "running",
      );
      const remainingBlocks = streamingBlocksRef.current.filter(
        (b) => !(b.type === "tool" && b.block?.status === "running"),
      );

      if (remainingText || remainingToolUse.length > 0 || remainingBlocks.length > 0) {
        const finalMessage: Message = {
          role: "assistant",
          content: remainingText,
          timestamp: Date.now(),
          toolUse: remainingToolUse.length > 0 ? [...remainingToolUse] : undefined,
          blocks: remainingBlocks.length > 0 ? [...remainingBlocks] : undefined,
        };
        setMessages((prev) => [...prev, finalMessage]);
      }
      streamingTextRef.current = "";
      streamingToolUseRef.current = [];
      streamingBlocksRef.current = [];
      thinkingOpenRef.current = null;
      setStreamingText("");
      setStreamingToolUse([]);
      setStreamingBlocks([]);
      setIsLoading(false);
    },
    [activeModel, config, providerConfig],
  );

  const submitUserPrompt = useCallback(
    async (trimmedInput: string, promptOverride?: string) => {
      // UserPromptSubmit hooks (non-blocking).
      runHooksFireAndForget("UserPromptSubmit", { prompt: trimmedInput, cwd: workingDirectory });

      // fileHistory: snapshot the CURRENT on-disk state of every file touched
      // by earlier turns, keyed by the 1-based index of the user message about
      // to be appended. /rewind <N> restores snapshot N, so rewinding to this
      // user message reverts files to their pre-turn state. (Files touched by
      // the very first turn have no snapshot — the pre-session state is
      // outside the fileHistory store's model; see utils/fileHistory.ts.)
      try {
        const files = [...touchedFilesRef.current];
        if (files.length > 0) {
          void snapshotFiles(messagesLenRef.current + 1, files, workingDirectory).catch(() => {});
        }
      } catch {
        // best-effort — snapshots must never block the chat loop
      }

      // Turn bookkeeping for the finish-notify rule + overload recovery guard.
      // retryFallbackRef is cleared here too so a leftover armed retry from a
      // turn that died mid-stream can never fire on a later turn.
      turnStartRef.current = Date.now();
      recoveryAttemptedRef.current = false;
      retryFallbackRef.current = null;

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
          onToolOutput: handleToolOutput,
          onTodosChange: handleTodosChange,
          history: messages,
        });

        const startTime = Date.now();
        const activePrompt = promptOverride !== undefined ? promptOverride : trimmedInput;
        const events = query({
          session,
          config: agentConfig,
          userMessage: activePrompt,
          workingDir: workingDirectory,
          abortController,
        });

        await processAgentStream(events);

        // One-shot overload recovery: if the stream ended with an overload
        // error AND a fallback was armed (error case in processAgentStream),
        // recreate the memory session with the fallback provider config and
        // re-issue the same prompt once. Guarded by recoveryAttemptedRef so
        // this can never loop. (Cast defeats TS flow-narrowing, which sees the
        // null reset above and would otherwise type the read as null.)
        const fallback = retryFallbackRef.current as ProviderConfig | null;
        if (fallback && !abortController.signal.aborted) {
          retryFallbackRef.current = null;
          try {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `⚠ Provider overloaded — retrying once with fallback: ${fallback.type}/${fallback.model}`,
                timestamp: Date.now(),
              },
            ]);
            resetMemorySession();
            const { session: fallbackSession } = getOrCreateMemorySession({
              providerConfig: fallback,
              agentConfig,
              workingDir: workingDirectory,
              memoryDir: `${os.homedir()}/.deepseek-code/memory`,
              maxContextTokens: 1_000_000,
              requestPermission,
              mcpServers,
              abortController,
              onToolResult: handleToolResult,
              onToolOutput: handleToolOutput,
              onTodosChange: handleTodosChange,
              history: messages,
            });
            const retryEvents = query({
              session: fallbackSession,
              config: agentConfig,
              userMessage: activePrompt,
              workingDir: workingDirectory,
              abortController,
            });
            await processAgentStream(retryEvents);
          } catch (retryError) {
            // If the fallback attempt itself throws, surface the ORIGINAL
            // overload condition via the overload hint.
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: overloadMessage(fallback.model ?? activeModel),
                timestamp: Date.now(),
              },
            ]);
            setIsLoading(false);
            const retryRaw = (retryError as Error).message || String(retryError);
            if (retryRaw) {
              process.stderr.write(`[overload-fallback] ${retryRaw}\n`);
            }
          }
        }

        const duration = Date.now() - startTime;
        setApiDurationMs((prev) => prev + duration);
      } catch (error) {
        const raw = (error as Error).message || String(error);

        // Route thrown errors through the same classification as stream
        // errors (session/model creation failures). No fallback retry here —
        // if session creation itself failed, re-creating it is unlikely to
        // succeed; surface the actionable hint instead.
        const cls = classifyError(raw);
        if (cls === "prompt-too-long") {
          setMessages((prev) => [
            ...prev,
            { role: "system", content: promptTooLongMessage(), timestamp: Date.now() },
          ]);
        } else if (cls === "overload") {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: overloadMessage(activeModel), timestamp: Date.now(), isError: true },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `Error: ${raw}`,
              timestamp: Date.now(),
              isError: true,
            },
          ]);
        }
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
          // Rendered by the ported HelpView pane (catalog in
          // src/constants/help.ts); Esc closes it.
          setShowHelp(true);
          return true;
        }

        // ── /statusline (custom status line, Claude Code parity) ────────
        case "/statusline": {
          const current = (() => {
            try {
              return loadSettings().statusLine;
            } catch {
              return undefined;
            }
          })();

          const usage = [
            "Usage:",
            "  /statusline <command>   Set the status-line command — its trimmed stdout",
            "                          renders right-aligned on the status bar",
            "  /statusline off         Clear the custom status line",
            "",
            "The command runs after each finished turn and every ~20s (5s timeout,",
            "trust-gated like hooks — untrusted workspaces skip it).",
          ];

          if (!arg) {
            const content = current
              ? ["Custom status line is configured:", `  ${current.command}`, "", ...usage].join("\n")
              : ["Custom status line is not configured.", "", ...usage].join("\n");
            setMessages((prev) => [
              ...prev,
              { role: "system", content, timestamp: Date.now() },
            ]);
            return true;
          }

          if (arg === "off") {
            handleUpdateSetting("statusLine", undefined);
            statusLineTextRef.current = null;
            setStatusLineText(null);
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: "✓ Custom status line cleared.",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          const command = restArgs.join(" ");
          handleUpdateSetting("statusLine", { type: "command", command });
          statusLineTextRef.current = null;
          setStatusLineText(null);
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content:
                `✓ Status line set to: ${command}\n` +
                "(Runs after each turn and every ~20s — output shows right-aligned on the status bar.)",
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
          setTodos([]);
          contextManagerRef.current.reset();
          return true;

        case "/compact": {
          if (messages.length === 0) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "No messages to compact.", timestamp: Date.now() },
            ]);
            return true;
          }

          // Build a summary from the conversation for the agent's context
          const userMessages = messages
            .filter((m) => m.role === "user")
            .slice(-8)
            .map((m) => m.content.slice(0, 200))
            .filter(Boolean);

          const toolCount = messages
            .filter((m) => m.toolUse?.length)
            .reduce((sum, m) => sum + (m.toolUse?.length ?? 0), 0);

          const summaryParts: string[] = [
            `[Context compacted: ${messages.length} messages summarized]`,
          ];
          if (userMessages.length > 0) {
            summaryParts.push(`Topics discussed: ${userMessages.join("; ")}`);
          }
          if (toolCount > 0) {
            summaryParts.push(`Tool calls made: ${toolCount}`);
          }

          // Reset the C++ session so the next query starts fresh
          resetMemorySession();
          // Reset TypeScript-side context tracking so the bar reflects freed space
          contextManagerRef.current.reset();
          setTokenCount(0);
          setInputTokens(0);
          setOutputTokens(0);

          setMessages([
            { role: "system", content: summaryParts.join("\n"), timestamp: Date.now() },
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

        case "/hooks": {
          const hooks = loadHooks();
          const events = Object.keys(hooks) as Array<keyof typeof hooks>;
          const lines: string[] = ["── Lifecycle Hooks ──", ""];
          if (events.length === 0) {
            lines.push("  No hooks configured.");
            lines.push("");
            lines.push("  Configure in ~/.deepseek-code/settings.json:");
            lines.push('  {');
            lines.push('    "hooks": {');
            lines.push('      "PreToolUse": [');
            lines.push('        { "matcher": "Bash", "hooks": [ { "type": "command", "command": "your-script.sh" } ] }');
            lines.push('      ]');
            lines.push('    }');
            lines.push('  }');
            lines.push("");
            lines.push("  Events: PreToolUse · PostToolUse · UserPromptSubmit · Stop · Notification");
            lines.push('  PreToolUse can block a tool: exit code 2, or JSON {"decision":"block","reason":"..."}.');
          } else {
            for (const ev of events) {
              const groups = hooks[ev] || [];
              lines.push(`  ${String(ev)}:`);
              for (const g of groups) {
                for (const h of g.hooks || []) {
                  lines.push(`    [${g.matcher || "*"}] ${h.command}`);
                }
              }
            }
          }
          setMessages((prev) => [
            ...prev,
            { role: "system", content: lines.join("\n"), timestamp: Date.now() },
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
                  "Shift+Tab cycles permission mode.\n\n" +
                  "  off    disabled\n" +
                  "  whale  deep reasoning with extended thinking",
                timestamp: Date.now(),
              },
            ]);
          }
          return true;
        }

        // ── /effort ────────────────────────────────────────────────────
        case "/effort": {
          // Ported from claude-code-main/src/commands/effort/effort.tsx —
          // same args (low|medium|high|max|auto|current|status|help), same
          // messages and level descriptions.
          const EFFORT_DESCRIPTIONS: Record<string, string> = {
            low: "Quick, straightforward implementation",
            medium: "Balanced approach with standard testing",
            high: "Comprehensive implementation with extensive testing",
            xhigh: "Extra thorough implementation (maps to high)",
            max: "Maximum capability with deepest reasoning",
          };

          if (arg !== undefined && ["help", "-h", "--help"].includes(arg)) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  "Usage: /effort [low|medium|high|xhigh|max|auto]\n\n" +
                  "Effort levels:\n" +
                  "- low: Quick, straightforward implementation\n" +
                  "- medium: Balanced approach with standard testing\n" +
                  "- high: Comprehensive implementation with extensive testing\n" +
                  "- xhigh: Extra thorough implementation\n" +
                  "- max: Maximum capability with deepest reasoning\n" +
                  "- auto: Use the default effort level for your model",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          if (!arg) {
            // The reference prints the current level; ours additionally opens
            // the interactive EffortCallout selector (the dialog with the
            // ◯ low · ◐ medium · ● high legend). Esc/30s dismisses.
            setShowEffortCallout(true);
            return true;
          }

          if (arg === "current" || arg === "status") {
            const current = effortLevel === "off" || effortLevel === undefined ? "auto" : effortLevel;
            const description =
              current === "auto"
                ? "Use the default effort level for your model"
                : EFFORT_DESCRIPTIONS[current] ?? "";
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  current === "auto"
                    ? `Effort level: auto`
                    : `Current effort level: ${current} (${description})`,
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          const level = arg.toLowerCase();
          if (level === "auto" || level === "unset") {
            try {
              saveSettings({ effort: "off" });
            } catch {}
            setEffortLevel("off");
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "Effort level set to auto", timestamp: Date.now() },
            ]);
            return true;
          }

          if (!isEffortLevel(level)) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `Invalid argument: ${arg}. Valid options are: low, medium, high, xhigh, max, auto`,
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          try {
            saveSettings({ effort: level });
          } catch {
            // best-effort — settings persistence must not block the command
          }
          setEffortLevel(level);
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `Set effort level to ${level}: ${EFFORT_DESCRIPTIONS[level]}`,
              timestamp: Date.now(),
            },
          ]);
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
          // Legacy cost readout — stays on the old SettingsPanel overlay.
          setSettingsOverlayTab("usage");
          setShowSettingsOverlay(true);
          return true;

        case "/usage":
          setSettingsTab("Usage");
          setShowSettingsUI(true);
          return true;

        case "/settings":
          // Legacy settings overlay — unchanged.
          setSettingsOverlayTab("settings");
          setShowSettingsOverlay(true);
          return true;

        case "/status":
          setSettingsTab("Status");
          setShowSettingsUI(true);
          return true;

        case "/config":
          setSettingsTab("Config");
          setShowSettingsUI(true);
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
          handleExit();
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
   - You can call multiple tools or run commands sequentially. Stage and commit in one go if possible.${
          settingsSnapshot.includeCoAuthoredBy
            ? "\n\n3. After the commit message body, append a trailer line:\n   Co-Authored-By: DeepSeek Code <noreply@deepseek.com>"
            : ""
        }`;

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

        // ── /export ─────────────────────────────────────────────────────
        case "/export": {
          const formatArg = (parts[1] || "markdown").toLowerCase();
          if (formatArg !== "markdown" && formatArg !== "md" && formatArg !== "json") {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  "Usage: /export [markdown|json]\n\n" +
                  "Exports the conversation to a file in the current directory\n" +
                  "including thinking/reasoning text.",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          const format = formatArg === "json" ? "json" : "markdown";
          if (messages.length === 0) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "No messages to export.", timestamp: Date.now() },
            ]);
            return true;
          }

          // Interactive export dialog (ported ExportView): format choice +
          // include-thinking toggle; the write happens on Enter. The dialog
          // performs the write itself via onExport and shows the result.
          setExportDialog({ defaultFormat: format });
          return true;
        }

        // ── /search ─────────────────────────────────────────────────────
        case "/search": {
          const queryStr = restArgs.join(" ");
          if (!queryStr) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  "Usage: /search <query>\n\n" +
                  "Case-insensitive substring search over the conversation\n" +
                  "(pass a regex pattern for /search ^foo$ style matching).",
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          const result = searchMessages(messages, queryStr, { limit: 30 });
          if (!result.valid) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `Invalid search pattern: ${queryStr} (regex failed to compile).`,
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          if (result.matches.length === 0) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: `No matches for "${queryStr}".`, timestamp: Date.now() },
            ]);
            return true;
          }

          // Interactive results overlay (ported SearchResultsView): ↑↓
          // navigate, n/N next match, Enter jumps to the message, Esc closes.
          setSearchResults({
            query: queryStr,
            matches: result.matches.slice(0, 20),
            total: result.matches.length,
          });
          return true;
        }

        // ── /skills ─────────────────────────────────────────────────────
        case "/skills": {
          const skills = listSkills();

          if (!arg) {
            if (skills.length === 0) {
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content:
                    "No skills available.\n\n" +
                    "Add SKILL.md files to .claude/skills/<name>/ in this project\n" +
                    "or ~/.claude/skills/<name>/ for user-wide skills.",
                  timestamp: Date.now(),
                },
              ]);
              return true;
            }
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: [
                  `━━━ Skills (${skills.length}) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                  ...skills.map(
                    (s) => `  ${s.name.padEnd(20)} ${s.description}  (${s.source})`,
                  ),
                  "",
                  "Usage: /skills <name> to view a skill's full instructions.",
                ].join("\n"),
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          const skill = getSkill(arg);
          if (!skill) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content:
                  `Skill not found: ${arg}\n\n` +
                  `Available: ${skills.length > 0 ? skills.map((s) => s.name).join(", ") : "(none)"}`,
                timestamp: Date.now(),
              },
            ]);
            return true;
          }

          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: [
                `━━━ Skill: ${skill.name} (${skill.source}) ━━━━━━━━━━━━━━━━━━━━`,
                `Path: ${skill.path}`,
                skill.description ? `Description: ${skill.description}` : "",
                "",
                "```",
                skill.content,
                "```",
              ].filter(Boolean).join("\n"),
              timestamp: Date.now(),
            },
          ]);
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
          const targetDepth = idx + 1;
          const oldDepth = messages.length;
          const truncated = messages.slice(0, targetDepth);
          setMessages(truncated);

          // Restore on-disk file snapshots captured at this transcript depth.
          // snapshotFiles runs at each user-turn start keyed by the 1-based
          // message index, so snapshot N holds the file state right before
          // message N was appended. Rewinding to message N therefore reverts
          // files to the state the transcript implies. Messages with no
          // snapshot (assistant replies, the very first message) leave files
          // untouched — hasSnapshot guards that.
          void (async () => {
            const restored: string[] = [];
            if (hasSnapshot(targetDepth)) {
              try {
                const entries = await restoreSnapshot(targetDepth, workingDirectory);
                for (const entry of entries) {
                  try {
                    if (entry.content === null) {
                      await rm(entry.path, { force: true }); // deletion marker
                    } else {
                      await mkdir(dirname(entry.path), { recursive: true });
                      await writeFile(entry.path, entry.content, "utf-8");
                    }
                    restored.push(entry.path);
                  } catch {
                    // per-file best-effort — a bad file must not abort the rewind
                  }
                }
              } catch {
                // snapshot unreadable — rewind proceeds without file restore
              }
            }

            // Drop snapshots deeper than the new depth (they describe a
            // transcript that no longer exists) so a later /rewind cannot
            // restore stale file state. Also GCs orphaned blobs.
            for (let k = targetDepth + 1; k <= oldDepth; k++) {
              try {
                await dropSnapshot(k);
              } catch {
                // best-effort
              }
            }

            const suffix =
              restored.length > 0
                ? `\n✓ Restored ${restored.length} file${restored.length === 1 ? "" : "s"}:\n` +
                  restored
                    .map((p) => {
                      try {
                        return `    ${relative(workingDirectory, p)}`;
                      } catch {
                        return `    ${p}`;
                      }
                    })
                    .join("\n")
                : "";
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `✓ Rewound conversation back to message #${targetDepth}.${suffix}`,
                timestamp: Date.now(),
              },
            ]);
          })();
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

        // ── /plugin ─────────────────────────────────────────────────────
        case "/plugin":
        case "/plugins":
          setShowPluginOverlay(true);
          return true;

        // ── Claude Code command parity additions ────────────────────────
        case "/init": {
          const file = resolve(workingDirectory, "CLAUDE.md");
          if (existsSync(file)) {
            setMessages((prev) => [...prev, { role: "system", content: `CLAUDE.md already exists at ${file}`, timestamp: Date.now() }]);
          } else {
            const template = [
              "# CLAUDE.md",
              "",
              "This file provides guidance to DeepSeek Code when working with code in this repository.",
              "",
              "## Project overview",
              "",
              "<!-- Describe what this project does -->",
              "",
              "## Build and test commands",
              "",
              "<!-- e.g.: bun run build / bun test -->",
              "",
              "## Code style",
              "",
              "<!-- Conventions the agent should follow -->",
            ].join("\n");
            writeFileSync(file, template + "\n");
            setMessages((prev) => [...prev, { role: "system", content: `✓ Created ${file} — it's loaded into context for future sessions.`, timestamp: Date.now() }]);
          }
          return true;
        }

        case "/memory": {
          const file = resolve(workingDirectory, "CLAUDE.md");
          if (!existsSync(file)) {
            writeFileSync(file, "# CLAUDE.md\n\n<!-- Add project guidance here — it is loaded into context automatically. -->\n");
          }
          setMessages((prev) => [...prev, {
            role: "system",
            content: `CLAUDE.md memory file: ${file}\nEdit it in your editor — its contents are loaded into context for future sessions.`,
            timestamp: Date.now(),
          }]);
          return true;
        }

        case "/permissions": {
          const rules = (() => { try { return loadSettings().permissions; } catch { return undefined; } })();
          const lines = ["Permission rules (settings.permissions):", ""];
          if (!rules || ((rules.allow?.length ?? 0) === 0 && (rules.deny?.length ?? 0) === 0 && (rules.ask?.length ?? 0) === 0)) {
            lines.push("  (none configured — tools prompt interactively)");
          } else {
            for (const r of rules.allow ?? []) lines.push(`  allow  ${r}`);
            for (const r of rules.deny ?? []) lines.push(`  deny   ${r}`);
            for (const r of rules.ask ?? []) lines.push(`  ask    ${r}`);
          }
          lines.push(
            "",
            "Syntax: Tool(spec:pattern), e.g.",
            '  "allow": ["Read(**)", "Edit(src/**)"]',
            '  "deny": ["Bash(rm -rf *)"]',
            "",
            "Configure via /settings → permissions.",
          );
          setMessages((prev) => [...prev, { role: "system", content: lines.join("\n"), timestamp: Date.now() }]);
          return true;
        }

        case "/theme": {
          if (!arg) {
            // Interactive ThemePicker (reference parity — /theme opens it).
            setShowThemePicker(true);
            return true;
          }
          handleThemeModeChange(arg as ThemeSetting);
          setMessages((prev) => [...prev, { role: "system", content: `Theme set to ${arg}`, timestamp: Date.now() }]);
          return true;
        }

        case "/output-style": {
          const styles = listOutputStyles();
          if (!arg) {
            const current = (() => { try { return loadSettings().outputStyle; } catch { return undefined; } })();
            const lines = [`Current output style: ${current ?? "default"}`, "", "Available:"];
            for (const s of styles) lines.push(`  ${s.name === (current ?? "default") ? "▸" : " "} ${s.name.padEnd(20)} ${s.description}`);
            lines.push("", "Usage: /output-style <name>  |  /output-style default  |  /output-style explain <name>");
            setMessages((prev) => [...prev, { role: "system", content: lines.join("\n"), timestamp: Date.now() }]);
            return true;
          }
          if (arg === "default") {
            handleUpdateSetting("outputStyle", undefined);
            setMessages((prev) => [...prev, { role: "system", content: "Output style reset to default", timestamp: Date.now() }]);
            return true;
          }
          if (arg === "explain" && parts[2]) {
            const style = styles.find((s) => s.name === parts[2]);
            if (style) {
              setMessages((prev) => [...prev, { role: "system", content: `${style.name}: ${style.description}`, timestamp: Date.now() }]);
              return true;
            }
          }
          const style = styles.find((s) => s.name === arg);
          if (!style) {
            setMessages((prev) => [...prev, { role: "system", content: `Unknown output style: ${arg}. Run /output-style to list them.`, timestamp: Date.now() }]);
            return true;
          }
          handleUpdateSetting("outputStyle", style.name);
          setMessages((prev) => [...prev, { role: "system", content: `✓ Output style set to ${style.name}`, timestamp: Date.now() }]);
          return true;
        }

        case "/review":
        case "/security-review": {
          const security = command === "/security-review";
          const prompt = security
            ? "Perform a security review of the uncommitted changes in this repository: look for injection vulnerabilities, unsafe input handling, secrets, path traversal, and unsafe shell usage. Report findings by severity."
            : "Review the uncommitted changes in this repository for bugs, correctness issues, and code quality problems. Report findings with file paths and line numbers.";
          setCurrentAgent("review");
          void submitUserPrompt(prompt, prompt);
          return true;
        }

        case "/todos": {
          const items = todos;
          if (items.length === 0) {
            setMessages((prev) => [...prev, { role: "system", content: "No todos — the TodoWrite tool adds items as the agent works.", timestamp: Date.now() }]);
          } else {
            const lines = ["Todos:"];
            items.forEach((t, i) => {
              lines.push(`  ${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"} ${t.content}`);
            });
            setMessages((prev) => [...prev, { role: "system", content: lines.join("\n"), timestamp: Date.now() }]);
          }
          return true;
        }

        case "/context": {
          const budget = contextManagerRef.current.getBudget();
          const max = budget?.maxContextTokens ?? 1_000_000;
          const used = inputTokens + outputTokens;
          const pct = Math.min(100, Math.round((used / max) * 100));
          setMessages((prev) => [...prev, {
            role: "system",
            content:
              `Context window usage:\n` +
              `  ${used.toLocaleString()} / ${max.toLocaleString()} tokens (${pct}%) — reserved ${(budget?.reservedForResponse ?? 4096).toLocaleString()} for response\n` +
              `  Session messages: ${messages.length}\n` +
              `  The native session compacts automatically near the limit; /compact forces a summary.`,
            timestamp: Date.now(),
          }]);
          return true;
        }

        case "/env": {
          const lines = ["Environment variables:", ""];
          for (const v of ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL", "DEEPSEEK_FALLBACK_MODEL"]) {
            const val = process.env[v];
            lines.push(`  ${val ? "✓" : "✗"} ${v}${val && v === "DEEPSEEK_API_KEY" ? " (set, hidden)" : val ? ` = ${val}` : ""}`);
          }
          const custom = (() => { try { return Object.keys(loadSettings().env ?? {}); } catch { return []; } })();
          if (custom.length > 0) lines.push("", `settings.env: ${custom.join(", ")}`);
          setMessages((prev) => [...prev, { role: "system", content: lines.join("\n"), timestamp: Date.now() }]);
          return true;
        }

        case "/branch": {
          try {
            const proc = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: workingDirectory });
            const branch = proc.stdout?.toString().trim() || "(detached HEAD)";
            setMessages((prev) => [...prev, { role: "system", content: `Current branch: ${branch}`, timestamp: Date.now() }]);
          } catch {
            setMessages((prev) => [...prev, { role: "system", content: "Not a git repository.", timestamp: Date.now() }]);
          }
          return true;
        }

        case "/bashes": {
          const tasks = listTasks();
          if (tasks.length === 0) {
            setMessages((prev) => [...prev, { role: "system", content: "No background tasks running.", timestamp: Date.now() }]);
          } else {
            const lines = ["Background tasks:"];
            for (const t of tasks) lines.push(`  #${t.id} ${t.status.padEnd(10)} ${t.command.slice(0, 60)}`);
            lines.push("", "Read output with TaskOutput, kill with TaskStop.");
            setMessages((prev) => [...prev, { role: "system", content: lines.join("\n"), timestamp: Date.now() }]);
          }
          return true;
        }

        case "/workspace": {
          const trusted = isTrusted(workingDirectory);
          setMessages((prev) => [...prev, {
            role: "system",
            content:
              `Workspace: ${workingDirectory}\n` +
              `Trust: ${trusted ? "trusted" : "untrusted (hooks and /statusline are disabled)"}`,
            timestamp: Date.now(),
          }]);
          return true;
        }

        case "/plan": {
          setCurrentAgent("plan");
          setMessages((prev) => [...prev, { role: "system", content: "Switched to plan agent — read-only analysis mode. Shift+Tab cycles permission modes; /agent code returns to full access.", timestamp: Date.now() }]);
          return true;
        }

        default: {
          // Custom slash commands (markdown files under .deepseek-code/commands/).
          const custom = customCommands.find((c) => c.name === command.slice(1).toLowerCase());
          if (custom) {
            void submitUserPrompt(cmd, renderCommand(custom, restArgs));
            return true;
          }
          const pluginCommandName = command.slice(1).trim().toLowerCase(); // strip leading "/"
          try {
            const plugins = loadInstalledPlugins();
            const enabled = plugins.filter((p) => p.enabled);
            for (const p of enabled) {
              // Claude Code plugin commands/ (marketplace retro-compat)
              if (p.manifest.commands) {
                const pcmd = p.manifest.commands.find(
                  (c) => c.name.toLowerCase() === pluginCommandName,
                );
                if (pcmd) {
                  const userArg = restArgs.join(" ");
                  const fullPrompt = `${pcmd.prompt}\n\nUser request/argument: ${userArg || "(none)"}`;
                  void submitUserPrompt(cmd, fullPrompt);
                  return true;
                }
              }
              if (p.manifest.skills) {
                const skill = p.manifest.skills.find((s) => s.name.toLowerCase() === pluginCommandName);
                if (skill) {
                  const userArg = restArgs.join(" ");
                  const fullPrompt = `${skill.prompt}\n\nUser request/argument: ${userArg || "(none)"}`;
                  void submitUserPrompt(cmd, fullPrompt);
                  return true;
                }
              }
            }
          } catch {}
          return false;
        }
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
      effortLevel,
      mcpEntries,
      mcpCount,
      mcpEnabledCount,
      mcpServers,
      workingDirectory,
      submitUserPrompt,
      customCommands,
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
      try {
        inputHistory.current = appendHistory(trimmedInput);
      } catch {
        // best-effort persistence
      }
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
  // ThemeProvider mounts the ported design-system context (used by
  // ExportView/SearchResultsView/PermissionPrompt) and keeps the legacy
  // mutable `theme` module in sync with the persisted themeMode.
  return (
    <ThemeProvider
      initialState={themeMode}
      onThemeSave={(setting) => handleThemeModeChange(setting)}
    >
    {showOnboarding ? (
      // First-time setup (Claude Code parity): full-screen step flow before
      // the chat UI is usable.
      <Onboarding
        hasApiKey={!!activeApiKey}
        initialTheme={themeMode}
        version="0.1.0"
        onDone={handleOnboardingDone}
      />
    ) : (
    // Terminal-height ceiling (Claude Code: <AlternateScreen>'s
    // <Box height={rows}>): chat flexGrows in the middle, the bottom slot
    // (input + status) is flexShrink={0} so it stays pinned to the last
    // rows no matter how many messages are on screen.
    <Box flexDirection="column" height={termRows}>
      {/* Chat area */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        <ChatPanel
          messages={messages}
          isLoading={isLoading}
          streamingText={streamingText}
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
          isTranscriptMode={isTranscriptMode}
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

      {/* Bottom slot — input + status bar + overlays. flexShrink={0} pins
          it to the terminal's last rows (Claude Code: bottom slot outside
          the ScrollBox never moves). */}
      <Box flexShrink={0} flexDirection="column">
      {showThemePicker ? (
        <ThemePicker
          helpText="Esc to cancel"
          onThemeSelect={(setting) => {
            setShowThemePicker(false);
            handleThemeModeChange(setting);
            setMessages((prev) => [...prev, { role: "system", content: `Theme set to ${setting}`, timestamp: Date.now() }]);
          }}
          onCancel={() => setShowThemePicker(false)}
          initialTheme={themeMode}
        />
      ) : showEffortCallout ? (
        <EffortCallout onDone={handleEffortCalloutDone} currentLevel={effortLevel} />
      ) : showHelp ? (
        <HelpView version="0.1.0" />
      ) : exportDialog ? (
        <ExportView
          defaultFormat={exportDialog.defaultFormat}
          onCancel={() => setExportDialog(null)}
          onExport={(fmt, includeThinking) => {
            const ext = fmt === "json" ? "json" : "md";
            const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const filePath = resolve(workingDirectory, `deepseek-code-export-${ts}.${ext}`);
            return writeToFile(messages, fmt, filePath, { includeThinking }).then(
              (result) => ({
                success: true,
                message: `Exported ${messages.length} message${messages.length === 1 ? "" : "s"} to ${filePath} (${result.bytes} bytes, ${fmt})`,
              }),
            );
          }}
        />
      ) : searchResults ? (
        <SearchResultsView
          query={searchResults.query}
          matches={searchResults.matches}
          totalMatches={searchResults.total}
          onClose={() => setSearchResults(null)}
          onJump={(messageIndex) => {
            // Jump the transcript to the match's message: select its first
            // tool block in Inspect Mode if it has one.
            const blocks = getFlatToolBlocks();
            const idx = blocks.findIndex((b) => b.messageIdx === messageIndex);
            if (idx >= 0) {
              setInspectMode(true);
              setInspectIndex(idx);
            }
          }}
        />
      ) : showHistorySearch ? (
        <HistorySearch
          entries={historySnapshot}
          onPick={(entry) => {
            setInput(entry);
            setShowHistorySearch(false);
          }}
          onClose={() => setShowHistorySearch(false)}
        />
      ) : showSessionPicker ? (
        <SessionPicker
          sessions={sessionsList}
          selectedIndex={sessionPickerIndex}
          currentDirectory={workingDirectory}
        />
      ) : showSettingsUI ? (
        <Settings defaultTab={settingsTab} onClose={() => setShowSettingsUI(false)} />
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
          themeMode={themeMode.startsWith("light") ? "light" : "dark"}
          onChangeThemeMode={(mode) => handleThemeModeChange(mode)}
          thinkingMode={thinkingMode}
          onChangeThinkingMode={handleThinkingModeChange}
          dangerouslySkipPermissions={skipPermissions}
          onChangeSkipPermissions={handleSkipPermissionsChange}
          settings={settingsSnapshot}
          onUpdateSetting={handleUpdateSetting}
        />
      ) : showPluginOverlay ? (
        <PluginPanel
          onClose={() => setShowPluginOverlay(false)}
          onRefreshPlugins={refreshPlugins}
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

          {/* Live todo list (driven by the TodoWrite tool) */}
          {tasksExpanded && <TodoList todos={todos} selectedIndex={tasksSelectedIndex} />}

          {/* @-file mention dropdown */}
          {mention && !mentionSuppressed && mentionMatches.length > 0 && (
            <FileMentions matches={mentionMatches} selectedIndex={mentionIndex} query={mention.query} />
          )}

          {/* Input prompt */}
          <TextInput
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

          {/* Command picker — shown below the prompt (Claude-style) */}
          {showCommandPicker && (
            <CommandPicker
              commands={filteredCommands}
              selectedIndex={Math.min(commandPickerIndex, Math.max(0, filteredCommands.length - 1))}
            />
          )}

          {/* Status bar (footer row — Claude Code PromptInputFooter parity) */}
          <StatusBar
            model={activeModel}
            agentName={currentAgent}
            isLoading={isLoading}
            tokenCount={tokenCount}
            inputTokens={inputTokens}
            outputTokens={outputTokens}
            thinkingMode={thinkingMode}
            effort={effortLevel}
            mcpEnabledCount={mcpEnabledCount}
            queueCount={queuedSubmissions.length}
            queuePreview={queuedSubmissions[0]}
            currentFile={currentFile}
            awaitingPermission={!!pendingPermission}
            cost={cost}
            inspectMode={inspectMode}
            permissionMode={permissionMode}
            tokenBudget={contextManagerRef.current.getBudget()}
            statusLineOutput={statusLineText}
            tasks={{
              done: todos.filter((t) => t.status === "completed").length,
              total: todos.length,
              inProgress: todos.filter((t) => t.status === "in_progress").length,
              expanded: tasksExpanded,
            }}
          />
        </>
      )}
      </Box>
    </Box>
    )}
    </ThemeProvider>
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
