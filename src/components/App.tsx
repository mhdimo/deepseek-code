








import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { basename } from "node:path";
import ChatPanel, { type ChatPanelHandle } from "./ChatPanel.js";
import { useMouseWheelScroll, isMouseSequence } from "./useMouseWheelScroll.js";
import { useMouseSelection, type ContentSelection } from "./useMouseSelection.js";
import CommandPicker, { filterCommands, ALL_COMMANDS } from "./CommandPicker.js";
import type { CommandDef } from "./CommandPicker.js";
import ShortcutOverlay from "./ShortcutOverlay.js";
import SessionPicker from "./SessionPicker.js";
import StatusBar from "./StatusBar.js";
import TextInput from "./TextInput.js";
import Spinner from "./Spinner.js";
import PermissionPrompt from "./PermissionPrompt.js";
import AskUserQuestionsPrompt from "./AskUserQuestionsPrompt.js";
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
import { buildStatusLineCommandInput } from "../utils/statusline.js";
import { agentManager } from "../services/agent/index.js";
import { createModel } from "../services/provider/registry.js";
import { query } from "../services/query.js";
import { getOrCreateMemorySession, resetMemorySession } from "../services/agent/agentSession.js";
import os from "node:os";
import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { listOutputStyles } from "../services/outputStyles.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, relative, dirname, join } from "node:path";
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
  AskUserQuestion,
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
import { Settings } from "./Settings/Settings.js";
import { recordSessionStats } from "../state/stats.js";
import { runHooksFireAndForget } from "../services/hooks.js";
import {
  loadCustomCommands,
  renderCommand,
  toCommandDefs,
  type CustomCommand,
} from "../services/customCommands.js";
import PluginPanel from "./PluginPanel.js";
import { loadInstalledPlugins } from "../services/pluginService.js";
import { clearSkillsCache } from "../skills/skillService.js";
import { shutdownLspServerManager } from "../services/lsp/manager.js";
import TaskListV2 from "./TaskListV2.js";
import HistorySearch from "./HistorySearch.js";
import FileMentions from "./FileMentions.js";
import ModelPicker from "./ModelPicker.js";
import AgentPicker from "./AgentPicker.js";
import ContextView from "./ContextView.js";
import DoctorView from "./DoctorView.js";
import TasksView from "./TasksView.js";
import PermissionsView from "./PermissionsView.js";
import HooksView from "./HooksView.js";
import McpView from "./McpView.js";
import SkillsMenu from "./SkillsMenu.js";
import RewindPicker, { type RewindMode } from "./RewindPicker.js";
import CopyPicker from "./CopyPicker.js";
import MemoryPicker from "./MemoryPicker.js";
import OutputStylePicker from "./OutputStylePicker.js";
import InputDialog from "./InputDialog.js";
import WorkflowsMenu from "./WorkflowsMenu.js";
import TeamsDialog from "./teams/TeamsDialog.js";
import { listWorkflows, getWorkflow, type Workflow } from "../services/workflow/workflowService.js";
import { startWorkflowRun } from "../services/workflow/runner.js";
import TasksStatusPill from "./TasksStatusPill.js";
import { listTasks } from "../services/tasks/backgroundFramework.js";
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
import { matchDecision, parsePermissionSettings, escapeRuleContent } from "../services/permissions.js";
import { parseSetupArguments, parseSlashCommand } from "../services/commands/commandRegistry.js";
import { safeTerminalRows } from "./terminalLayout.js";
import { formatDirectoryTree } from "../tools/LS/LSTool.js";
import { hasUltrathinkKeyword, ULTRATHINK_EFFORT } from "../utils/thinkingKeywords.js";



/**
 * Interactive slash-command overlays (Claude Code local-jsx equivalent): one
 * discriminator for every command view so the exclusive render chain and the
 * input guard stay in sync as views are added.
 */
type CommandOverlayView =
  | "model"
  | "agent"
  | "context"
  | "doctor"
  | "permissions"
  | "hooks"
  | "mcp"
  | "skills"
  | "tasks"
  | "rewind"
  | "copy"
  | "memory"
  | "output-style"
  | "apikey"
  | "baseurl"
  | "statusline"
  | "workflows"
  | "teams";

export default function App({ config, workingDirectory, resumeSessionHash: cliResumeHash }: { config: DeepSeekCodeConfig; workingDirectory: string; resumeSessionHash?: string }) {
  const { exit } = useApp();
  const handleExit = useCallback(() => {
    
    
    
    void shutdownLspServerManager();
    exit();
    setTimeout(() => {
      process.exit(0);
    }, 50);
  }, [exit]);

  
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // Spinner sentiment — if the last user message was frustrated, the working
  // indicator spins a tongue-in-cheek verb list instead of the normal one.
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const spinnerSentiment = lastUserMessage
    ? /\b(fuck|shit|bitch|asshole|bastard|damn|crap|cunt|dick|piss|bollocks|bugger|ass)\b/i.test(lastUserMessage.content)
      ? "frustrated"
      : "neutral"
    : "neutral";
  const [streamingText, setStreamingText] = useState("");
  const [streamingToolUse, setStreamingToolUse] = useState<ToolUseBlock[]>([]);
  const [streamingBlocks, setStreamingBlocks] = useState<MessageBlock[]>([]);
  const [currentAgent, setCurrentAgent] = useState<AgentName>(config.defaultAgent || "code");
  const [tokenCount, setTokenCount] = useState(0);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [cost, setCost] = useState(0);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  // Permission prompts queue (Claude Code toolUseConfirmQueue parity): parallel
  // subagents can request several tool approvals at once — each gets a slot
  // instead of clobbering a single state entry. The dialog renders the head.
  const [permissionQueue, setPermissionQueue] = useState<
    Array<{
      toolName: string;
      description: string;
      /** Tool input — the dialog renders a faithful diff from it. */
      input?: unknown;
      /** Matched permission rule / hook that raised this request (dim
       *  explanation line, e.g. "/permissions to update rules"). */
      explanation?: string;
      resolve: (decision: { approved: boolean; feedback?: string }) => void;
    }>
  >([]);
  const pendingPermission = permissionQueue[0] ?? null;
  const [pendingQuestions, setPendingQuestions] = useState<{
    questions: AskUserQuestion[];
    resolve: (answers: Record<string, string>) => void;
    reject: (reason?: unknown) => void;
  } | null>(null);
  const [sessionRules, setSessionRules] = useState<{ allow: string[]; deny: string[] }>({ allow: [], deny: [] });

  
  const [activeProvider, setActiveProvider] = useState<ProviderType>(config.provider);
  const [activeModel, setActiveModel] = useState(config.model);
  const [activeApiKey, setActiveApiKey] = useState(config.apiKey);
  const [activeBaseURL, setActiveBaseURL] = useState(config.baseURL);

  
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("off");

  
  
  
  
  
  
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

  
  const [inspectMode, setInspectMode] = useState(false);
  const [inspectIndex, setInspectIndex] = useState(0);
  const [isTranscriptMode, setIsTranscriptMode] = useState(false);

  
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [sessionPickerIndex, setSessionPickerIndex] = useState(0);
  const [sessionsList, setSessionsList] = useState<any[]>([]);

  
  const sessionStartMs = useRef(Date.now());
  const [apiDurationMs, setApiDurationMs] = useState(0);
  const [sessionLinesAdded, setSessionLinesAdded] = useState(0);
  const [sessionLinesRemoved, setSessionLinesRemoved] = useState(0);

  
  const [showSettingsUI, setShowSettingsUI] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"Status" | "Config" | "Usage" | "Stats">("Status");

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

  
  useEffect(() => {
    return () => {
      if (outputThrottleTimerRef.current) {
        clearTimeout(outputThrottleTimerRef.current);
      }
    };
  }, []);

  
  
  
  useEffect(() => {
    messagesLenRef.current = messages.length;
  }, [messages.length]);

  
  
  
  useEffect(() => {
    try {
      if (isLoading) {
        preventSleep();
      } else {
        allowSleep();
      }
    } catch {
      
    }
  }, [isLoading]);

  
  
  
  
  
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setResizeTick((t) => t + 1);
      }, 50); 
    };
    process.stdout.on("resize", handler);
    return () => {
      process.stdout.off("resize", handler);
      if (timer) clearTimeout(timer);
    };
  }, []);
  
  void resizeTick;

  
  const [mcpServers, setMcpServers] = useState<Record<string, MCPServerConfig>>(
    config.mcpServers || {},
  );

  const abortRef = useRef<AbortController | null>(null);
  const lastSubmittedPromptRef = useRef("");
  const lastEscTimeRef = useRef(0);
  const lastCtrlCTimeRef = useRef(0);
  const tokenTrackerRef = useRef(new TokenTracker(activeModel));
  const contextManagerRef = useRef(new ContextManager(activeModel));
  
  const pickerActiveRef = useRef(false);
  
  const handleSubmitRef = useRef<(overrideInput?: string) => void>(() => {});

  const streamingTextRef = useRef("");
  /** Length of argsJson at the last full JSON.parse attempt (throttles
   *  per-delta parsing of large tool arguments — see tool-call-delta). */
  const lastArgsParseLenRef = useRef(0);
  const streamingToolUseRef = useRef<ToolUseBlock[]>([]);
  const streamingBlocksRef = useRef<MessageBlock[]>([]);
  
  const thinkingOpenRef = useRef<MessageBlock | null>(null);
  const pendingOutputsRef = useRef<Record<string, string>>({});
  const outputThrottleTimerRef = useRef<NodeJS.Timeout | null>(null);

  
  const messagesLenRef = useRef(0);
  
  const touchedFilesRef = useRef<Set<string>>(new Set());
  
  const turnStartRef = useRef(0);
  
  const recoveryAttemptedRef = useRef(false);
  
  const retryFallbackRef = useRef<ProviderConfig | null>(null);

  
  
  
  
  
  const flushDirtyRef = useRef({ text: false, blocks: false, toolUse: false });
  const chatRef = useRef<ChatPanelHandle>(null);
  useMouseWheelScroll(chatRef);
  const [selection, setSelection] = useState<ContentSelection | null>(null);
  useMouseSelection(chatRef, setSelection);

  
  
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

  
  const [activeSessionHash, setActiveSessionHash] = useState<string | null>(null);

  
  const [themeMode, setThemeModeState] = useState<ThemeSetting>(() => {
    try {
      const settings = loadSettings();
      return settings.themeMode || "dark";
    } catch {
      return "dark";
    }
  });

  
  
  
  
  
  
  const { stdout } = useStdout();
  const [termRows, setTermRows] = useState<number>(() => safeTerminalRows(stdout?.rows ?? process.stdout.rows));
  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    const onResize = () => setTermRows(safeTerminalRows(stdout.rows));
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, termRows]);

  
  
  const [showThemePicker, setShowThemePicker] = useState(false);

  
  
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
        
      }
      setShowOnboarding(false);
    },
    [],
  );

  const [skipPermissions, setSkipPermissions] = useState(() => !!config.dangerouslySkipPermissions);

  
  const [permissionMode, setPermissionMode] = useState<"default" | "acceptEdits" | "plan" | "bypassPermissions">(
    config.dangerouslySkipPermissions ? "bypassPermissions" : "default",
  );
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;

  
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

  
  const [showPluginOverlay, setShowPluginOverlay] = useState(false);
  const [pluginCommands, setPluginCommands] = useState<CommandDef[]>([]);


  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);

  
  const [workflowCommands, setWorkflowCommands] = useState<CommandDef[]>([]);

  
  const [todos, setTodos] = useState<TodoItem[]>([]);
  
  
  const [tasksExpanded, setTasksExpanded] = useState(false);

  
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const [historySnapshot, setHistorySnapshot] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionSuppressed, setMentionSuppressed] = useState(false);
  const fileIndexRef = useRef<string[] | null>(null);

  
  
  
  
  const [showHelp, setShowHelp] = useState(false);
  const [exportDialog, setExportDialog] = useState<{ defaultFormat: ExportFormat } | null>(null);
  const [searchResults, setSearchResults] = useState<{
    query: string;
    matches: SearchMatch[];
    total: number;
  } | null>(null);

  
  const [commandOverlay, setCommandOverlay] = useState<{ view: CommandOverlayView } | null>(null);

  
  const pushSystem = useCallback((content: string) => {
    setMessages((prev) => [...prev, { role: "system", content, timestamp: Date.now() }]);
  }, []);

  
  const closeCommandOverlay = useCallback((dismissedAs?: string) => {
    setCommandOverlay(null);
    if (dismissedAs) {
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `${dismissedAs} dismissed.`, timestamp: Date.now() },
      ]);
    }
  }, []);

  
  const rewindToDepth = useCallback(
    async (messageNumber: number, mode: RewindMode = "both") => {
      const targetDepth = messageNumber;
      const oldDepth = messages.length;
      if (targetDepth < 1 || targetDepth > messages.length) return;
      if (mode === "conversation" || mode === "both") {
        setMessages(messages.slice(0, targetDepth));
      }

      const restored: string[] = [];
      const failures: string[] = [];
      if (mode === "code" || mode === "both") {
        if (hasSnapshot(targetDepth)) {
          let entries;
          try {
            entries = await restoreSnapshot(targetDepth, workingDirectory);
          } catch (e) {
            // Restore failures surface in the picker as a red error line.
            throw new Error(`Code restore failed: ${(e as Error).message}`);
          }
          for (const entry of entries) {
            try {
              if (entry.content === null) {
                await rm(entry.path, { force: true });
              } else {
                await mkdir(dirname(entry.path), { recursive: true });
                await writeFile(entry.path, entry.content, "utf-8");
              }
              restored.push(entry.path);
            } catch (e) {
              failures.push(`${entry.path}: ${(e as Error).message}`);
            }
          }
        }

        for (let k = targetDepth + 1; k <= oldDepth; k++) {
          try {
            await dropSnapshot(k);
          } catch {

          }
        }
      }

      const suffixParts: string[] = [];
      if (restored.length > 0) {
        suffixParts.push(
          `\n✓ Restored ${restored.length} file${restored.length === 1 ? "" : "s"}:\n` +
            restored
              .map((p) => {
                try {
                  return `    ${relative(workingDirectory, p)}`;
                } catch {
                  return `    ${p}`;
                }
              })
              .join("\n"),
        );
      }
      if (failures.length > 0) {
        suffixParts.push(
          `\n⚠ ${failures.length} file${failures.length === 1 ? "" : "s"} failed to restore:\n` +
            failures.map((f) => `    ${f}`).join("\n"),
        );
      }
      const suffix = suffixParts.join("");
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: `✓ Rewound conversation back to message #${targetDepth}.${suffix}`,
          timestamp: Date.now(),
        },
      ]);
    },
    [messages, workingDirectory],
  );

  
  const copyToClipboard = useCallback(
    (content: string) => {
      const lineCount = content.split("\n").length;
      const charCount = content.length;
      const filePath = join(os.homedir(), ".cache", "deepseek-code", "copy", "response.md");
      try {
        // OSC 52 clipboard write (iTerm2, kitty, foot, …) — terminal-agnostic;
        // the temp file is the reliable fallback and always written.
        process.stdout.write(`\x1b]52;c;${Buffer.from(content, "utf-8").toString("base64")}\x07`);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, content, "utf-8");
        pushSystem(
          `✓ Copied assistant response to clipboard (${charCount} characters, ${lineCount} lines). Also at ${filePath}`,
        );
      } catch (e) {
        pushSystem(`✗ Failed to copy to clipboard: ${(e as Error).message}`);
      }
    },
    [pushSystem],
  );

  
  const openInEditor = useCallback(
    (path: string) => {
      const editor = (process.env.EDITOR || process.env.VISUAL || "vi").trim();
      if (!existsSync(path)) {
        try {
          writeFileSync(
            path,
            path.endsWith("CLAUDE.md")
              ? "# CLAUDE.md\n\n<!-- Add project guidance here — it is loaded into context automatically. -->\n"
              : `# ${basename(path)}\n\n<!-- Created by /memory — edit to add guidance. -->\n`,
          );
        } catch {

        }
      }
      let failed: string | null = null;
      try {
        process.stdin.setRawMode?.(false);
        Bun.spawnSync(editor.split(/\s+/), {
          stdio: ["inherit", "inherit", "inherit"],
        });
      } catch (e) {
        failed = (e as Error).message;
      } finally {
        process.stdin.setRawMode?.(true);
      }
      let relPath = path;
      try {
        relPath = relative(workingDirectory, path);
      } catch {}
      if (failed) {
        pushSystem(`✗ Failed to open ${editor}: ${failed} — file is at ${path}`);
      } else {
        const editorHint = process.env.EDITOR || process.env.VISUAL ? "" : " To change editor, set $EDITOR or $VISUAL.";
        pushSystem(`Editing ${relPath} in ${editor} — changes apply to future sessions.${editorHint}`);
      }
    },
    [workingDirectory, pushSystem],
  );

  
  
  
  const [statusLineText, setStatusLineText] = useState<string | null>(null);
  const statusLineTextRef = useRef<string | null>(null);
  const statusLineAbortRef = useRef<AbortController | null>(null);
  const statusLineTimerRef = useRef<NodeJS.Timeout | null>(null);

  
  const statusLineSetting = (settingsSnapshot as { statusLine?: { type: "command"; command: string; padding?: number } })
    .statusLine;

  
  
  
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
    if (!isTrusted(workingDirectory)) return; 
    statusLineAbortRef.current?.abort(); 
    const controller = new AbortController();
    statusLineAbortRef.current = controller;
    const killTimer = setTimeout(() => controller.abort(), 5000);
    void (async () => {
      try {
        const proc = Bun.spawn(["sh", "-c", command], {
          stdout: "pipe",
          stderr: "ignore",
          stdin: "pipe",
          signal: controller.signal,
          cwd: workingDirectory,
        });
        // Rich JSON contract on stdin — see src/utils/statusline.ts for the
        // schema. Read via refs so the 20s refresh isn't stale.
        const usage = tokenTrackerRef.current.getSessionUsage();
        const payload = buildStatusLineCommandInput({
          model: activeModel,
          currentDir: workingDirectory,
          costUsd: tokenTrackerRef.current.estimateCost(usage).totalCost,
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          contextWindowSize: contextManagerRef.current.getBudget().maxContextTokens,
          agentName: currentAgent,
          permissionMode: permissionModeRef.current,
        });
        proc.stdin.write(JSON.stringify(payload) + "\n");
        proc.stdin.end();
        const stdout = await new Response(proc.stdout).text();
        clearTimeout(killTimer);
        if (controller.signal.aborted) return;
        const trimmed = stdout.trim();
        if (trimmed !== statusLineTextRef.current) {
          statusLineTextRef.current = trimmed;
          setStatusLineText(trimmed);
        }
      } catch {
        
        
      }
    })();
  }, [workingDirectory]);

  
  
  const scheduleStatusLineRun = useCallback(() => {
    if (statusLineTimerRef.current) clearTimeout(statusLineTimerRef.current);
    statusLineTimerRef.current = setTimeout(() => {
      statusLineTimerRef.current = null;
      runStatusLineCommand();
    }, 300);
  }, [runStatusLineCommand]);

  
  useEffect(() => {
    runStatusLineCommand();
    return () => {
      statusLineAbortRef.current?.abort();
      if (statusLineTimerRef.current) clearTimeout(statusLineTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatusLineCommand, statusLineSetting]);

  
  
  useEffect(() => {
    if (!statusLineSetting) return;
    const id = setInterval(() => runStatusLineCommand(), 20_000);
    return () => clearInterval(id);
  }, [statusLineSetting, runStatusLineCommand]);

  
  const prevLoadingRef = useRef(isLoading);
  useEffect(() => {
    if (prevLoadingRef.current && !isLoading) scheduleStatusLineRun();
    prevLoadingRef.current = isLoading;
  }, [isLoading, scheduleStatusLineRun]);

  const refreshPlugins = useCallback(() => {
    try {
      const plugins = loadInstalledPlugins();
      const enabled = plugins.filter((p) => p.enabled);

      
      
      
      const seen = new Set(ALL_COMMANDS.map((c) => c.name));
      const truncate = (s: string, max = 70) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
      const cmds: CommandDef[] = [];
      for (const p of enabled) {
        if (p.manifest.commands) {
          for (const pcmd of p.manifest.commands) {
            const name = pcmd.name.trim().replace(/^\/+/, "").toLowerCase();
            if (seen.has(name)) continue;
            seen.add(name);
            cmds.push({
              name,
              description: truncate(pcmd.description ?? `Plugin command from ${p.name}`),
              usage: [`/${name} `],
              category: "plugin",
              acceptsArgs: true,
              executionKey: "plugin",
            });
          }
        }
        if (p.manifest.skills) {
          for (const skill of p.manifest.skills) {
            const name = skill.name.trim().replace(/^\/+/, "").toLowerCase();
            if (seen.has(name)) continue;
            seen.add(name);
            cmds.push({
              name,
              description: truncate(skill.description),
              usage: [`/${name} `],
              category: "plugin",
              acceptsArgs: true,
              executionKey: "plugin",
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
      // Plugin skills are cached in skillService — invalidate after any
      // plugin install/enable/disable mutation so /skills reflects it.
      clearSkillsCache();
    } catch {}
  }, [config.mcpServers]);

  useEffect(() => {
    refreshPlugins();
  }, [refreshPlugins]);

  
  const inputHistory = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  // Draft captured when history recall starts, so ↓ past the newest entry
  // restores what the user was writing instead of wiping the input.
  const historyDraftRef = useRef("");

  
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
      
    }
  }, []);

  
  const yieldToRenderer = () => new Promise<void>((r) => setTimeout(r, 0));

  
  const extraCommands = useMemo(
    () => [...pluginCommands, ...workflowCommands, ...toCommandDefs(customCommands)],
    [pluginCommands, workflowCommands, customCommands],
  );
  const slashInputActive = input.trimStart().startsWith("/");
  const filteredCommands: CommandDef[] = !isLoading && slashInputActive ? filterCommands(input, extraCommands) : [];
  const parsedInput = parseSlashCommand(input);
  const isExactCommandMatch =
    filteredCommands.length === 1 &&
    parsedInput !== null &&
    filteredCommands[0]?.name === parsedInput.canonicalName &&
    parsedInput.args.length === 0;
  
  
  
  const firstWord = input.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const hasExactCommandPrefix =
    firstWord.length > 0 && filteredCommands.some((c) => `/${c.name}` === firstWord);
  const showCommandPicker =
    slashInputActive &&
    filteredCommands.length > 0 &&
    !isExactCommandMatch &&
    !hasExactCommandPrefix &&
    !input.includes("\n");
  
  pickerActiveRef.current = showCommandPicker;

  
  const mention = useMemo(
    () => (isLoading || showCommandPicker ? null : detectTrailingMention(input)),
    [input, isLoading, showCommandPicker],
  );
  const mentionMatches = useMemo(() => {
    if (!mention || mentionSuppressed) return [];

    
    
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

  
  useEffect(() => {
    try {
      inputHistory.current = loadHistory();
    } catch {
      
    }
    try {
      fileIndexRef.current = buildFileIndex(workingDirectory);
    } catch {
      fileIndexRef.current = [];
    }
    try {
      setCustomCommands(loadCustomCommands(workingDirectory));
    } catch {

    }
    try {
      setWorkflowCommands(
        listWorkflows().map((wf) => ({
          name: wf.name,
          description: `${wf.description} (workflow)`,
          usage: [`/${wf.name} `],
          category: "custom" as const,
          acceptsArgs: true,
          executionKey: "workflow",
        })),
      );
    } catch {

    }
    
    try {
      pruneOldSessions(loadSettings().cleanupPeriodDays ?? 30);
    } catch {
      
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mcpEntries = Object.entries(mcpServers);
  const mcpCount = mcpEntries.length;
  const mcpEnabledCount = mcpEntries.filter(([, s]) => s.enabled !== false).length;

  
  const providerConfig: ProviderConfig = {
    type: activeProvider,
    apiKey: activeApiKey,
    baseURL: activeBaseURL,
    model: activeModel,
  };

  
  
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
        
        pruneSessions(50);
      }

      
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
      
    }
  }, [messages.length, tokenCount, cost, apiDurationMs, sessionLinesAdded, sessionLinesRemoved]);

  
  useEffect(() => {
    if (!cliResumeHash) return; 
    try {
      let sessionHashToLoad = cliResumeHash;
      if (cliResumeHash === "latest") {
        const sessions = listSessions();
        
        const localSession = sessions.find((s) => s.workingDirectory === workingDirectory);
        if (localSession) {
          sessionHashToLoad = localSession.hash;
        } else {
          
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
      
    }
  }, []);

  
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

      return null; 
    },
    [config.profiles],
  );

  
  // Leaving transcript mode collapses the expanded thinking blocks: the old
  // scrollTop (often far up the transcript) points past the new content
  // height and the viewport goes blank. Snap back to the bottom —
  // synchronously, against the last-known collapsed content height, so the
  // very first frame after exit is already correct (no blank flash); the
  // deferred scrollToBottom re-pins once ink has re-laid-out the shrunken
  // content.
  const exitTranscriptMode = () => {
    chatRef.current?.snapBackAfterCollapse();
    setIsTranscriptMode(false);
    setTimeout(() => chatRef.current?.scrollToBottom(), 0);
  };

  useInput((_input, key) => {
    // Terminal mouse sequences reach every useInput handler as a raw string
    // like `[<64;10;15M` with an empty key name — never treat them as keys.
    if (isMouseSequence(_input)) return;
    if (key.ctrl && _input === "c") {
      if (pendingQuestions) {
        pendingQuestions.reject(new Error("Questions cancelled by user."));
        setPendingQuestions(null);
        return;
      }
      if (isTranscriptMode) {
        exitTranscriptMode();
        return;
      }
      if (showSessionPicker) {
        setShowSessionPicker(false);
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
      if (commandOverlay) {
        setCommandOverlay(null);
        return;
      }

      const now = Date.now();
      if (isLoading) {
        
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

    
    
    if (showOnboarding) {
      return;
    }

    
    if (showHistorySearch || showPluginOverlay || exportDialog || searchResults || showEffortCallout || showThemePicker || commandOverlay) {
      return;
    }

    if (pendingQuestions) {
      return;
    }

    
    
    
    
    
    
    
    
    if (showSettingsUI) {
      return; 
    }

    
    if (showHelp) {
      if (key.escape) {
        setShowHelp(false);
        return;
      }
      return; 
    }

    
    if (key.ctrl && _input === "a") {
      if (showSessionPicker) {
        // The picker owns ctrl+a (this-project ⇄ all-projects scope) while open.
        return;
      }
      if (!isLoading) {
        const list = listSessions();
        setSessionsList(list);
        setSessionPickerIndex(0);
        setShowSessionPicker(true);
      }
      return;
    }

    
    if (showSessionPicker) {
      // SessionPicker is self-contained (navigation, filter, preview, rename,
      // scope toggle) — pass every key through to it.
      return;
    }

    
    
    
    if ((key.ctrl && _input === "o") || _input === "\x0f") {
      if (isTranscriptMode) {
        exitTranscriptMode();
      } else {
        setIsTranscriptMode(true);
      }
      return;
    }


    if (isTranscriptMode) {
      if (key.escape || _input === "q") {
        exitTranscriptMode();
        return;
      }
      // Transcript mode scroll keys (input is unmounted here, so the full
      // modal pager set is free — Claude Code parity: arrows = line,
      // pgup/pgdn + ctrl+b/f = page, ctrl+u/d = half page, g/G = top/bottom).
      if (key.upArrow) {
        chatRef.current?.scrollBy(-1);
        return;
      }
      if (key.downArrow) {
        chatRef.current?.scrollBy(1);
        return;
      }
      if (key.pageUp || (key.ctrl && _input === "b")) {
        chatRef.current?.scrollPage(-1);
        return;
      }
      if (key.pageDown || (key.ctrl && _input === "f")) {
        chatRef.current?.scrollPage(1);
        return;
      }
      if (key.ctrl && _input === "u") {
        chatRef.current?.scrollHalf(-1);
        return;
      }
      if (key.ctrl && _input === "d") {
        chatRef.current?.scrollHalf(1);
        return;
      }
      if (key.home || _input === "g") {
        chatRef.current?.scrollToTop();
        return;
      }
      if (key.end || _input === "G") {
        chatRef.current?.scrollToBottom();
        return;
      }
      return;
    }

    
    if (key.ctrl && _input === "e") {
      const flatCount = getFlatToolBlocks().length;
      if (flatCount > 0) {
        setInspectMode((prev) => {
          const next = !prev;
          if (next) {
            setInspectIndex(flatCount - 1); 
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
      return;
    }

    // Normal mode scroll: page keys only (arrows/home/end/ctrl belong to
    // the text input; MultilineTextInput ignores pageUp/pageDown).
    if (key.pageUp) {
      chatRef.current?.scrollPage(-1);
      return;
    }
    if (key.pageDown) {
      chatRef.current?.scrollPage(1);
      return;
    }


    if (key.ctrl && _input === "r" && !isLoading) {
      setHistorySnapshot(inputHistory.current);
      setShowHistorySearch(true);
      return;
    }

    
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

    
    if (key.ctrl && _input === "q" && isLoading && queuedSubmissions.length > 0) {
      const count = queuedSubmissions.length;
      setQueuedSubmissions([]);
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Cleared ${count} queued prompt${count > 1 ? "s" : ""}.`, timestamp: Date.now() },
      ]);
      return;
    }

    
    if (_input === "?" && !isLoading && input.trim().length === 0 && !showCommandPicker) {
      setShowShortcuts((prev) => !prev);
      return;
    }

    
    if (key.escape) {
      if (selection) {
        // Esc clears an active mouse selection first (Claude Code parity).
        setSelection(null);
        return;
      }
      if (pendingPermission) {
        pendingPermission.resolve({ approved: false, feedback: "Cancelled with Esc" });
        setPermissionQueue((prev) => prev.slice(1));
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
        
        const now = Date.now();
        if (now - lastEscTimeRef.current < 500 && input.length > 0) {
          setInput("");
        }
        lastEscTimeRef.current = now;
      }
      return;
    }

    
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
          const usage = cmd.usage?.[0] ?? `/${cmd.name} `;
          if (key.return && !cmd.acceptsArgs) {
            handleSubmitRef.current(`/${cmd.name}`);
          } else {
            setInput(usage);
          }
          setCommandPickerIndex(0);
        }
        return;
      }
    }

    
    if (!key.upArrow && !key.downArrow && !key.tab && !key.return) {
      setCommandPickerIndex(0);
    }

    
    
    
    // ↓ expands the live todo panel (TaskListV2, static display) — but only
    // when no background tasks are running: their ↓ hint opens the tasks
    // manager instead (checked below).
    if (
      todos.length > 0 &&
      !showCommandPicker &&
      !isLoading &&
      !listTasks().some((t) => t.status === "running")
    ) {
      if (tasksExpanded) {
        if (key.escape || key.return) {
          setTasksExpanded(false);
          return;
        }
      } else if (key.downArrow && input.trim().length === 0) {
        setTasksExpanded(true);
        return;
      }
    }


    // ↓ with an empty input opens the tasks manager while agents / workflows /
    // shells are running (the footer pill's hint) — works mid-stream too,
    // so a fanout of foreground subagents can be inspected live.
    if (
      !showCommandPicker &&
      key.downArrow &&
      input.trim().length === 0 &&
      listTasks().some((t) => t.status === "running")
    ) {
      setCommandOverlay({ view: "tasks" });
      return;
    }

    // History recall on ↑/↓ — only when it cannot destroy a draft. In a
    // multi-line draft the arrows belong to the input (line navigation);
    // recalling here would clobber the whole draft. Walking past the newest
    // entry restores the saved draft (readline behavior) instead of clearing.
    if (!showCommandPicker && !isLoading) {
      if (key.upArrow) {
        if (inputHistory.current.length === 0) return;
        if (input.includes("\n")) return;
        if (historyIndex.current === -1) {
          historyDraftRef.current = input;
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
        if (input.includes("\n")) return;
        if (historyIndex.current < inputHistory.current.length - 1) {
          historyIndex.current += 1;
          const historical = inputHistory.current[historyIndex.current];
          if (historical !== undefined) {
            setInput(historical);
          }
        } else {
          historyIndex.current = -1;
          setInput(historyDraftRef.current);
        }
        return;
      }
    }

    
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

  
  const requestPermission = useCallback(
    (toolName: string, description: string, input?: unknown): Promise<{ approved: boolean; feedback?: string }> => {
      const mode = permissionModeRef.current;
      if (mode === "bypassPermissions") {
        return Promise.resolve({ approved: true });
      }
      if (mode === "plan") {
        return Promise.resolve({
          approved: false,
          feedback: "Plan mode is read-only. Press Shift+Tab to switch to a write-enabled mode.",
        });
      }
      const sessionDecision = matchDecision(
        parsePermissionSettings(sessionRules),
        toolName,
        input,
        workingDirectory,
      );
      if (sessionDecision.decision === "allow") {
        return Promise.resolve({ approved: true });
      }
      if (sessionDecision.decision === "deny") {
        return Promise.resolve({ approved: false, feedback: "Denied by a session rule." });
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
        setPermissionQueue((prev) => [...prev, { toolName, description, input, resolve }]);
      });
    },
    [sessionRules],
  );

  const askUserQuestions = useCallback(
    (questions: AskUserQuestion[]): Promise<Record<string, string>> => {
      if (questions.length === 0) return Promise.resolve({});
      return new Promise((resolve, reject) => {
        setPendingQuestions({ questions, resolve, reject });
      });
    },
    [],
  );

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      if (showShortcuts && value.trim().length > 0) {
        setShowShortcuts(false);
      }
      
      if (!detectTrailingMention(value)) {
        setMentionSuppressed(false);
      }
    },
    [showShortcuts],
  );

  const handleToolResult = useCallback((toolName: string, input: any, output: string, isError: boolean) => {
    if (!isError && input && typeof input === "object") {
      
      
      
      if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
        const fp = (input as { file_path?: unknown }).file_path;
        if (typeof fp === "string" && fp.length > 0) {
          try {
            touchedFilesRef.current.add(resolve(workingDirectory, fp));
          } catch {
            
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

    
    
    
    
  }, [workingDirectory]);

  // Live output streaming for tools that report incremental activity — Bash
  // command output and Agent subagent progress lines both flow through here
  // into the running tool block (throttled into ~100ms flushes).
  const handleToolOutput = useCallback((toolName: string, text: string) => {
    if (toolName !== "Bash" && toolName !== "Agent") return;


    pendingOutputsRef.current[toolName] = (pendingOutputsRef.current[toolName] || "") + text;


    if (!outputThrottleTimerRef.current) {
      outputThrottleTimerRef.current = setTimeout(() => {
        outputThrottleTimerRef.current = null;


        const flushed = pendingOutputsRef.current;
        pendingOutputsRef.current = {};


        for (const [flushedTool, textToAppend] of Object.entries(flushed)) {
          if (!textToAppend) continue;
          setStreamingToolUse((prev) => {
            const runningIdx = prev.findIndex(
              (b) => b.toolName === flushedTool && b.status === "running",
            );
            if (runningIdx === -1) return prev;

            const next = [...prev];
            const block = next[runningIdx]!;
            next[runningIdx] = {
              ...block,
              output: (block.output || "") + textToAppend,
            };
            streamingToolUseRef.current = next;


            const blockInListIdx = streamingBlocksRef.current.findIndex(
              (b) => b.type === "tool" && b.block?.toolName === flushedTool && b.block?.status === "running"
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
        }
      }, 100);
    }
  }, []);

  
  const handleTodosChange = useCallback((next: TodoItem[]) => {
    setTodos(next);
  }, []);

  
  const processAgentStream = useCallback(
    async (events: AsyncGenerator<AgentEvent | QueryEvent>) => {
      
      streamingTextRef.current = "";
      streamingToolUseRef.current = [];
      streamingBlocksRef.current = [];
      thinkingOpenRef.current = null;
      setStreamingBlocks([]);

      for await (const event of events) {
        switch (event.type) {
          case "thinking-start":


            {
              const block: MessageBlock = { type: "thinking", content: "", thinkingStart: Date.now() };
              streamingBlocksRef.current.push(block);
              thinkingOpenRef.current = block;
              flushDirtyRef.current.blocks = true;
              scheduleStreamingFlush();
            }
            break;

          case "thinking-delta": {


            if (!thinkingOpenRef.current) {
              const block: MessageBlock = { type: "thinking", content: "", thinkingStart: Date.now() };
              streamingBlocksRef.current.push(block);
              thinkingOpenRef.current = block;
              flushDirtyRef.current.blocks = true;
            }
            thinkingOpenRef.current.content += event.text;
            flushDirtyRef.current.blocks = true;
            scheduleStreamingFlush();
            break;
          }

          case "thinking-end": {
            const block = thinkingOpenRef.current;
            if (block) block.thinkingEnd = Date.now();
            thinkingOpenRef.current = null;
            flushDirtyRef.current.blocks = true;
            scheduleStreamingFlush();
            break;
          }

          case "text-delta":
            // The text lives ONLY in the streaming blocks (append-only to the
            // last text block). Keeping a second copy in streamingTextRef
            // doubled the memory of every streamed token; the final message
            // content is derived from the blocks when the turn ends.
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

              
              // Parsing the WHOLE growing args JSON on every delta is O(n^2)
              // for large tool arguments (a 50KB Write arg streamed in small
              // deltas re-parses ~25MB total). Only attempt a full parse
              // every ~2KB of growth; the regex path below keeps the live
              // file/command preview cheap between attempts, and tool-call-end
              // does the final authoritative parse.
              let parsedInput = "";
              if (newArgsJson.length - (lastArgsParseLenRef.current ?? 0) >= 2048) {
                lastArgsParseLenRef.current = newArgsJson.length;
                try {
                  const parsed = JSON.parse(newArgsJson);
                  parsedInput = formatToolInput(event.toolName, parsed);
                } catch {
                  
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
              } else {
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
                
              }

              
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
                content: `Context compacted: ${event.messagesBefore} → ${event.messagesAfter} messages (${event.reason})`,
                timestamp: Date.now(),
              },
            ]);
            break;

          case "finish":
            setTokenCount(event.usage.totalTokens); 
            setInputTokens(event.usage.promptTokens);
            setOutputTokens(event.usage.completionTokens);
            
            contextManagerRef.current.trackUsage(event.usage);
            
            if (contextManagerRef.current.shouldWarn()) {
              const pct = contextManagerRef.current.getUsagePercent();
              setMessages((prev) => [
                ...prev,
                {
                  role: "system",
                  content: `Warning: context at ${pct}% — approaching limit. Use /compact to free space or /clear to start fresh.`,
                  timestamp: Date.now(),
                },
              ]);
            }
            if (event.cost) {
              const totalCost = event.cost.totalCost;
              setCost((prev) => prev + totalCost);
            }
            
            
            
            
            
            
            if (turnStartRef.current > 0 && Date.now() - turnStartRef.current > 20_000) {
              void notify({ body: `Response ready (${activeModel})`, bell: true }).catch(() => {});
            }
            runHooksFireAndForget("Stop", { cwd: workingDirectory });
            break;

          case "error": {
            const errorText = event.error;
            const cls = classifyError(errorText);

            
            
            
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

            
            if (cls === "overload") {
              if (!recoveryAttemptedRef.current) {
                const fallback = resolveFallbackProvider(config, providerConfig);
                if (fallback) {
                  
                  
                  
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

      
      
      
      // The streamed text lives in the text blocks (see text-delta); derive
      // the final message content from them instead of a second string copy.
      const remainingText = streamingBlocksRef.current
        .filter((b): b is MessageBlock & { type: "text" } => b.type === "text")
        .map((b) => b.content ?? "")
        .join("");
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
      
      runHooksFireAndForget("UserPromptSubmit", { prompt: trimmedInput, cwd: workingDirectory });

      
      
      
      
      
      
      try {
        const files = [...touchedFilesRef.current];
        if (files.length > 0) {
          void snapshotFiles(messagesLenRef.current + 1, files, workingDirectory).catch(() => {});
        }
      } catch {
        
      }

      
      
      
      turnStartRef.current = Date.now();
      recoveryAttemptedRef.current = false;
      retryFallbackRef.current = null;


      // ultrathink (Claude Code parity): the keyword in a non-command prompt
      // bumps this single turn's reasoning effort to high; the next turn
      // reverts to the configured level.
      const ultrathink = !trimmedInput.startsWith("/") && hasUltrathinkKeyword(trimmedInput);

      const userMessage: Message = {
        role: "user",
        content: trimmedInput,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

      if (ultrathink) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: "⚡ ultrathink — reasoning effort set to high for this turn.",
            timestamp: Date.now(),
          },
        ]);
      }

      
      if (!activeApiKey) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content:
              "Warning: no API key configured.\n\n" +
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

      
      const abortController = new AbortController();
      abortRef.current = abortController;

      
      tokenTrackerRef.current.setModel(activeModel);
      contextManagerRef.current.setModel(activeModel);

      try {
        const agentConfig = agentManager.resolveConfig(currentAgent) ?? agentManager.getConfig("code");

        
        const { session } = getOrCreateMemorySession({
          providerConfig,
          agentConfig,
          workingDir: workingDirectory,
          memoryDir: `${os.homedir()}/.deepseek-code/memory`,
          maxContextTokens: 1_000_000,
          requestPermission,
          askUserQuestions,
          mcpServers,
          abortController,
          onToolResult: handleToolResult,
          onToolOutput: handleToolOutput,
          onTodosChange: handleTodosChange,
          onSystemMessage: pushSystem,
          history: messages,
          effortOverride: ultrathink ? ULTRATHINK_EFFORT : undefined,
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

        
        
        
        
        
        
        const fallback = retryFallbackRef.current as ProviderConfig | null;
        if (fallback && !abortController.signal.aborted) {
          retryFallbackRef.current = null;
          try {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `Warning: provider overloaded — retrying once with fallback: ${fallback.type}/${fallback.model}`,
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
              askUserQuestions,
              mcpServers,
              abortController,
              onToolResult: handleToolResult,
              onToolOutput: handleToolOutput,
              onTodosChange: handleTodosChange,
              onSystemMessage: pushSystem,
              history: messages,
              effortOverride: ultrathink ? ULTRATHINK_EFFORT : undefined,
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
      askUserQuestions,
      processAgentStream,
      activeModel,
      activeProvider,
      activeBaseURL,
    ],
  );


  // Workflow launch: registers the run as a background task and notifies via
  // system messages (progress lives in the task output — /tasks to watch).
  const launchWorkflow = useCallback(
    (workflowOrName: Workflow | string, input: string) => {
      const wf = typeof workflowOrName === "string" ? getWorkflow(workflowOrName) : workflowOrName;
      if (!wf) {
        pushSystem(`Workflow not found: ${workflowOrName}. Use /workflows to list available workflows.`);
        return;
      }
      const taskId = startWorkflowRun(wf, input, {
        providerConfig,
        workingDir: workingDirectory,
        requestPermission,
        onSystemMessage: pushSystem,
      });
      pushSystem(`▶ Workflow "${wf.name}" started (task ${taskId}) — watch it live with /tasks.`);
    },
    [providerConfig, workingDirectory, requestPermission, pushSystem],
  );

  const handleCommand = useCallback(
    (cmd: string): boolean => {
      const parsed = parseSlashCommand(cmd);
      if (!parsed) return false;
      const command = parsed.canonicalName;
      const arg = parsed.args[0];
      const restArgs = parsed.args;

      switch (command) {
        case "help": {
          
          
          setShowHelp(true);
          return true;
        }


        case "statusline": {
          if (!arg) {
            setCommandOverlay({ view: "statusline" });
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

        
        case "setup": {
          const setupArgs = parseSetupArguments(parsed);

          if (!setupArgs) {
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

          
          const key = setupArgs.apiKey;
          const resolvedModel = setupArgs.model || "deepseek-chat";
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

        case "logout": {
          setActiveApiKey("");
          persistSettings({ apiKey: "" });
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: "Saved API key cleared. Use /setup <api-key> or /apikey <key> to connect again.",
              timestamp: Date.now(),
            },
          ]);
          return true;
        }


        case "model": {
          if (!arg) {
            setCommandOverlay({ view: "model" });
            return true;
          }

          
          const result = switchModel(arg);
          if (result) {
            persistSettings({ model: arg, apiKey: config.profiles?.[arg]?.apiKey });
            setMessages((prev) => [
              ...prev,
              { role: "system", content: `✓ ${result}\n✓ Saved to ~/.deepseek-code/settings.json`, timestamp: Date.now() },
            ]);
          } else {
            
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


        case "models": {
          setCommandOverlay({ view: "model" });
          return true;
        }


        case "apikey": {
          const key = restArgs.join("");
          if (!key) {
            setCommandOverlay({ view: "apikey" });
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


        case "baseurl": {
          const url = restArgs.join(" ").trim();
          if (!url) {
            setCommandOverlay({ view: "baseurl" });
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


        case "agent": {
          if (!arg) {
            setCommandOverlay({ view: "agent" });
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

        case "clear":
          setMessages([]);
          resetMemorySession();
          setSessionRules({ allow: [], deny: [] });
          setTokenCount(0);
          setInputTokens(0);
          setOutputTokens(0);
          setTodos([]);
          contextManagerRef.current.reset();
          return true;

        case "compact": {
          if (messages.length === 0) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "No messages to compact.", timestamp: Date.now() },
            ]);
            return true;
          }

          
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

          
          resetMemorySession();
          
          contextManagerRef.current.reset();
          setTokenCount(0);
          setInputTokens(0);
          setOutputTokens(0);

          setMessages([
            { role: "system", content: summaryParts.join("\n"), timestamp: Date.now() },
          ]);
          return true;
        }

        case "tools": {
          const tools = getToolDescriptions();
          const agentConfig = agentManager.resolveConfig(currentAgent) ?? agentManager.getConfig("code");
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

        case "hooks": {
          setCommandOverlay({ view: "hooks" });
          return true;
        }

        case "workflows": {
          setCommandOverlay({ view: "workflows" });
          return true;
        }

        case "teams": {
          setCommandOverlay({ view: "teams" });
          return true;
        }

        case "shortcuts": {
          setShowShortcuts((prev) => !prev);
          return true;
        }

        case "mcp": {
          const action = restArgs[0]?.toLowerCase();
          const serverName = restArgs[1];

          if (!action || action === "list") {
            setCommandOverlay({ view: "mcp" });
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

        case "think": {
          const VALID_MODES: ThinkingMode[] = ["off", "whale"];
          if (arg && VALID_MODES.includes(arg as ThinkingMode)) {
            const newMode = arg as ThinkingMode;
            setThinkingMode(newMode);
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: newMode === "off"
                  ? "Thinking disabled."
                  : "Whalethink enabled — deep reasoning mode active.",
                timestamp: Date.now(),
              },
            ]);
          } else if (!arg) {
            
            const next = thinkingMode === "off" ? "whale" : "off";
            setThinkingMode(next);
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: next === "off"
                  ? "Thinking disabled."
                  : "Whalethink enabled — deep reasoning mode active.",
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

        
        case "effort": {
          
          
          
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

        case "queue": {
          const subCmd = restArgs[0]?.toLowerCase();
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

        case "cost":
          
          setSettingsTab("Usage");
          setShowSettingsUI(true);
          return true;

        case "usage":
          setSettingsTab("Usage");
          setShowSettingsUI(true);
          return true;

        case "settings":
          
          setSettingsTab("Config");
          setShowSettingsUI(true);
          return true;

        case "status":
          setSettingsTab("Status");
          setShowSettingsUI(true);
          return true;

        case "config":
          setSettingsTab("Config");
          setShowSettingsUI(true);
          return true;

        case "stats":
          
          
          setSettingsTab("Stats");
          setShowSettingsUI(true);
          return true;

        case "exit":
          if (activeSessionHash) {
            
            process.stderr.write(`\n  Session saved: ${activeSessionHash}\n  Resume with: deepseek-code --resume ${activeSessionHash}\n\n`);
          }
          handleExit();
          return true;


        case "sessions": {
          if (arg === "clear" || arg === "new") {
            setMessages([]);
            resetMemorySession();
            setSessionRules({ allow: [], deny: [] });
            setTokenCount(0);
            setActiveSessionHash(null);
            setMessages([{ role: "system", content: "✓ Started a new session.", timestamp: Date.now() }]);
            return true;
          }
          const sessions = listSessions();
          if (sessions.length === 0) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: "No saved sessions.", timestamp: Date.now() },
            ]);
            return true;
          }
          
          
          setSessionsList(sessions);
          setSessionPickerIndex(0);
          setShowSessionPicker(true);
          return true;
        }


        case "resume": {
          if (!arg) {
            const sessions = listSessions();
            if (sessions.length === 0) {
              setMessages((prev) => [
                ...prev,
                { role: "system", content: "No saved sessions.", timestamp: Date.now() },
              ]);
              return true;
            }
            setSessionsList(sessions);
            setSessionPickerIndex(0);
            setShowSessionPicker(true);
            return true;
          }
          if (arg === "clear" || arg === "new") {
            setMessages([]);
            resetMemorySession();
            setSessionRules({ allow: [], deny: [] });
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

        
        case "commit": {
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

        
        case "pr": {
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


        case "copy": {
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

          let bypass = false;
          try {
            bypass = loadSettings().copyFullResponse === true;
          } catch {}

          if (!arg) {
            if (bypass) {
              copyToClipboard(assistantMsgs[assistantMsgs.length - 1]!.content);
              return true;
            }
            setCommandOverlay({ view: "copy" });
            return true;
          }

          const N = parseInt(arg, 10);
          if (isNaN(N) || N <= 0) {
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `Usage: /copy [N] where N is 1 (latest), 2, 3, … Got: "${arg}"`,
                timestamp: Date.now(),
              },
            ]);
            return true;
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

          copyToClipboard(assistantMsgs[assistantMsgs.length - N]!.content);
          return true;
        }

        
        case "export": {
          const formatArg = (restArgs[0] || "markdown").toLowerCase();
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

          
          
          
          setExportDialog({ defaultFormat: format });
          return true;
        }

        
        case "search": {
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

          
          
          setSearchResults({
            query: queryStr,
            matches: result.matches.slice(0, 20),
            total: result.matches.length,
          });
          return true;
        }


        case "skills": {
          const skills = listSkills();

          if (!arg) {
            
            setCommandOverlay({ view: "skills" });
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

        
        case "diff": {
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

        
        case "history": {
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

        
        case "rewind": {
          if (!arg) {
            if (messages.length === 0) {
              setMessages((prev) => [
                ...prev,
                { role: "system", content: "Nothing to rewind — the conversation is empty.", timestamp: Date.now() },
              ]);
              return true;
            }
            setCommandOverlay({ view: "rewind" });
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
          rewindToDepth(idx + 1);
          return true;
        }

        
        case "doctor": {
          setCommandOverlay({ view: "doctor" });
          return true;
        }

        
        case "plugin":
          setShowPluginOverlay(true);
          return true;

        
        case "init": {
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

        case "memory": {
          setCommandOverlay({ view: "memory" });
          return true;
        }

        case "files": {
          const target = resolve(workingDirectory, arg || ".");
          try {
            const entries = readdirSync(target, { withFileTypes: true })
              .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
              .sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
              });
            const lines = formatDirectoryTree(entries.map((entry) => ({
              name: entry.name,
              isDirectory: entry.isDirectory(),
            })));
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: `${target}/\n${lines.length > 0 ? lines.join("\n") : "(empty directory)"}`,
                timestamp: Date.now(),
              },
            ]);
          } catch (error) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: `Unable to list ${target}: ${(error as Error).message}`, timestamp: Date.now() },
            ]);
          }
          return true;
        }

        case "permissions": {
          setCommandOverlay({ view: "permissions" });
          return true;
        }

        case "theme": {
          if (!arg) {
            
            setShowThemePicker(true);
            return true;
          }
          handleThemeModeChange(arg as ThemeSetting);
          setMessages((prev) => [...prev, { role: "system", content: `Theme set to ${arg}`, timestamp: Date.now() }]);
          return true;
        }

        case "output-style": {
          const styles = listOutputStyles();
          if (!arg) {
            setCommandOverlay({ view: "output-style" });
            return true;
          }
          if (arg === "default") {
            handleUpdateSetting("outputStyle", undefined);
            setMessages((prev) => [...prev, { role: "system", content: "Output style reset to default", timestamp: Date.now() }]);
            return true;
          }
          if (arg === "explain" && restArgs[1]) {
            const style = styles.find((s) => s.name === restArgs[1]);
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

        case "review":
        case "security-review": {
          const security = command === "security-review";
          const prompt = security
            ? "Perform a security review of the uncommitted changes in this repository: look for injection vulnerabilities, unsafe input handling, secrets, path traversal, and unsafe shell usage. Report findings by severity."
            : "Review the uncommitted changes in this repository for bugs, correctness issues, and code quality problems. Report findings with file paths and line numbers.";
          setCurrentAgent("review");
          void submitUserPrompt(prompt, prompt);
          return true;
        }

        case "todos": {
          if (todos.length === 0) {
            setMessages((prev) => [...prev, { role: "system", content: "No todos — the TodoWrite tool adds items as the agent works.", timestamp: Date.now() }]);
            return true;
          }
          setTasksExpanded(true);
          return true;
        }

        case "context": {
          setCommandOverlay({ view: "context" });
          return true;
        }

        case "env": {
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

        case "branch": {
          try {
            const proc = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: workingDirectory });
            const branch = proc.stdout?.toString().trim() || "(detached HEAD)";
            setMessages((prev) => [...prev, { role: "system", content: `Current branch: ${branch}`, timestamp: Date.now() }]);
          } catch {
            setMessages((prev) => [...prev, { role: "system", content: "Not a git repository.", timestamp: Date.now() }]);
          }
          return true;
        }

        case "bashes": {
          setCommandOverlay({ view: "tasks" });
          return true;
        }

        case "test": {
          const requested = arg?.toLowerCase();
          const commandArgs = requested === "typecheck"
            ? ["run", "typecheck"]
            : requested === "build"
              ? ["run", "build"]
              : ["test"];
          const commandLabel = `bun ${commandArgs.join(" ")}`;
          try {
            const result = Bun.spawnSync(["bun", ...commandArgs], {
              cwd: workingDirectory,
              stdout: "pipe",
              stderr: "pipe",
            });
            const stdoutText = result.stdout?.toString().trim() ?? "";
            const stderrText = result.stderr?.toString().trim() ?? "";
            const output = [stdoutText, stderrText].filter(Boolean).join("\n");
            setMessages((prev) => [
              ...prev,
              {
                role: "system",
                content: [
                  `${commandLabel} exited with code ${result.exitCode}.`,
                  output ? "" : "No output.",
                  output.slice(-12000),
                ].filter((line) => line !== "").join("\n"),
                timestamp: Date.now(),
              },
            ]);
          } catch (error) {
            setMessages((prev) => [
              ...prev,
              { role: "system", content: `Unable to run ${commandLabel}: ${(error as Error).message}`, timestamp: Date.now() },
            ]);
          }
          return true;
        }

        case "version": {
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `DeepSeek Code v0.1.0\nBun ${Bun.version}\nNode compatibility ${process.version}`,
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        case "terminal-setup": {
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: [
                "Terminal setup",
                "",
                "- Use a terminal with ANSI color and alternate-screen support.",
                "- The interface uses full redraws to keep streaming output and permission prompts aligned.",
                "- Ctrl+O toggles the detailed transcript; Esc closes overlays.",
                "- If the terminal is narrow, resize it before starting a long tool call.",
              ].join("\n"),
              timestamp: Date.now(),
            },
          ]);
          return true;
        }

        case "workspace": {
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

        case "plan": {
          setCurrentAgent("plan");
          setMessages((prev) => [...prev, { role: "system", content: "Switched to plan agent — read-only analysis mode. Shift+Tab cycles permission modes; /agent code returns to full access.", timestamp: Date.now() }]);
          return true;
        }

        default: {
          // Workflow commands take precedence over custom/plugin commands of
          // the same name (mirrors Claude Code's load order).
          const workflow = getWorkflow(command);
          if (workflow) {
            launchWorkflow(workflow, parsed.rawArgs.trim());
            return true;
          }
          const custom = customCommands.find((c) => c.name.replace(/^\/+/, "").toLowerCase() === command);
          if (custom) {
            void submitUserPrompt(cmd, renderCommand(custom, restArgs));
            return true;
          }
          const pluginCommandName = command;
          try {
            const plugins = loadInstalledPlugins();
            const enabled = plugins.filter((p) => p.enabled);
            for (const p of enabled) {
              
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
      rewindToDepth,
      copyToClipboard,
      launchWorkflow,
    ],
  );

  
  const handleSubmit = useCallback(async (overrideInput?: string) => {
    const rawInput = overrideInput !== undefined ? overrideInput : input;
    if (!rawInput.trim()) return;
    
    if (pickerActiveRef.current && overrideInput === undefined) return;

    const trimmedInput = rawInput.trim();
    if (!trimmedInput.startsWith("/")) {
      lastSubmittedPromptRef.current = trimmedInput;
    }
    setInput("");
    // A new prompt supersedes any in-progress mouse selection.
    setSelection(null);

    // A new prompt was sent — snap the transcript back to the bottom.
    chatRef.current?.scrollToBottom();


    if (trimmedInput && inputHistory.current[inputHistory.current.length - 1] !== trimmedInput) {
      try {
        inputHistory.current = appendHistory(trimmedInput);
      } catch {
        
      }
    }
    historyIndex.current = -1;

    
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

    
    if (!isLoading && trimmedInput.startsWith("/")) {
      if (handleCommand(trimmedInput)) return;
      
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

    
    if (isLoading) {
      setQueuedSubmissions((prev) => [...prev, trimmedInput]);
      return;
    }

    await submitUserPrompt(trimmedInput);
  }, [input, isLoading, handleCommand, submitUserPrompt]);

  
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  
  useEffect(() => {
    if (isLoading) return;
    if (queuedSubmissions.length === 0) return;

    const [next, ...rest] = queuedSubmissions;
    setQueuedSubmissions(rest);
    void submitUserPrompt(next!);
  }, [isLoading, queuedSubmissions, submitUserPrompt]);




  
  const renderCommandOverlay = () => {
    switch (commandOverlay?.view) {
      case "model":
        return (
          <ModelPicker
            currentModel={activeModel}
            currentProvider={activeProvider}
            profiles={config.profiles}
            currentEffort={effortLevel}
            availableModels={(config as DeepSeekCodeConfig & { availableModels?: string[] }).availableModels}
            onSelect={(name, effort) => {
              setCommandOverlay(null);
              if (effort !== undefined) {
                try {
                  saveSettings({ effort });
                } catch {}
                setEffortLevel(effort);
              }
              const result = switchModel(name);
              if (result) {
                persistSettings({ model: name, apiKey: config.profiles?.[name]?.apiKey });
                pushSystem(`✓ ${result}\n✓ Saved to ~/.deepseek-code/settings.json`);
              } else {
                setActiveModel(name);
                persistSettings({ model: name });
                pushSystem(`✓ Model changed to: ${name}\n✓ Saved to ~/.deepseek-code/settings.json`);
              }
            }}
            onCancel={() => closeCommandOverlay("Model picker")}
          />
        );

      case "agent":
        return (
          <AgentPicker
            agents={agentManager.listSelectableAgents()}
            currentAgent={currentAgent}
            onSelect={(name) => {
              setCommandOverlay(null);
              setCurrentAgent(name as AgentName);
              pushSystem(`Switched to ${name} agent.`);
            }}
            onCancel={() => closeCommandOverlay("Agent picker")}
          />
        );

      case "context":
        return (
          <ContextView
            inputTokens={inputTokens}
            outputTokens={outputTokens}
            budget={contextManagerRef.current.getBudget()}
            messages={messages}
            model={activeModel}
            mcpServers={mcpServers}
            onClose={() => setCommandOverlay(null)}
          />
        );

      case "doctor":
        return (
          <DoctorView
            provider={activeProvider}
            model={activeModel}
            baseURL={activeBaseURL}
            apiKeyPreview={activeApiKey ? activeApiKey.slice(0, 8) + "…" + activeApiKey.slice(-4) : undefined}
            onClose={() => setCommandOverlay(null)}
          />
        );

      case "permissions":
        return (
          <PermissionsView
            persistedRules={(() => {
              try {
                return loadSettings().permissions ?? {};
              } catch {
                return {};
              }
            })()}
            sessionRules={sessionRules}
            onPersistRules={(rules) => handleUpdateSetting("permissions", rules)}
            onSessionRulesChange={(next) => setSessionRules(next)}
            onPersistProjectRules={(rules) => {
              try {
                const fs = require("node:fs") as typeof import("node:fs");
                const pathMod = require("node:path") as typeof import("node:path");
                const configPath = pathMod.join(process.cwd(), ".deepseek-code.json");
                const existing = fs.existsSync(configPath)
                  ? JSON.parse(fs.readFileSync(configPath, "utf-8"))
                  : {};
                fs.writeFileSync(
                  configPath,
                  JSON.stringify({ ...existing, permissions: rules }, null, 2) + "\n",
                );
              } catch (e) {
                pushSystem(`✗ Failed to save project permissions: ${(e as Error).message}`);
              }
            }}
            onSummary={(summary) => pushSystem(summary)}
            onClose={() => setCommandOverlay(null)}
          />
        );

      case "hooks":
        return <HooksView onClose={() => setCommandOverlay(null)} />;

      case "workflows":
        return (
          <WorkflowsMenu
            onRun={(workflow) => launchWorkflow(workflow, "")}
            onClose={() => setCommandOverlay(null)}
          />
        );

      case "teams":
        return <TeamsDialog onClose={() => setCommandOverlay(null)} />;

      case "mcp":
        return (
          <McpView
            servers={mcpServers}
            onToggle={(name, enabled) => {
              setMcpServers((prev) => prev[name] ? { ...prev, [name]: { ...prev[name]!, enabled } } : prev);
              pushSystem(`${enabled ? "✓" : "✗"} MCP server ${name} ${enabled ? "enabled" : "disabled"}.`);
            }}
            onReconnect={async (name) => {
              resetMemorySession();
              pushSystem(
                name
                  ? `✓ Session reset — ${name} reconnects on your next message.`
                  : "✓ Native session reset — MCP servers reconnect on your next message.",
              );
            }}
            onClose={() => setCommandOverlay(null)}
          />
        );

      case "skills":
        return <SkillsMenu onClose={() => setCommandOverlay(null)} />;

      case "tasks":
        return <TasksView onClose={() => setCommandOverlay(null)} />;

      case "rewind":
        return (
          <RewindPicker
            messages={messages}
            workingDirectory={workingDirectory}
            onRewind={async (messageNumber, mode) => {
              await rewindToDepth(messageNumber, mode);
              // Repopulate the input with the restored user message text.
              setInput(messages[messageNumber - 1]?.content ?? "");
            }}
            onClose={() => setCommandOverlay(null)}
          />
        );

      case "copy":
        return (
          <CopyPicker
            messages={messages}
            onCopy={(content) => {
              setCommandOverlay(null);
              copyToClipboard(content);
            }}
            onWrite={(result) => {
              setCommandOverlay(null);
              pushSystem(result);
            }}
            onClose={() => {
              setCommandOverlay(null);
              pushSystem("Copy cancelled");
            }}
          />
        );

      case "memory":
        return (
          <MemoryPicker
            workingDirectory={workingDirectory}
            onOpenInEditor={(path) => {
              setCommandOverlay(null);
              openInEditor(path);
            }}
            onClose={() => {
              setCommandOverlay(null);
              pushSystem("Cancelled memory editing");
            }}
          />
        );

      case "output-style":
        return (
          <OutputStylePicker
            current={(() => {
              try {
                return loadSettings().outputStyle;
              } catch {
                return undefined;
              }
            })()}
            onSelect={(name) => {
              setCommandOverlay(null);
              if (name === "default") {
                handleUpdateSetting("outputStyle", undefined);
                pushSystem("Output style reset to default");
              } else {
                handleUpdateSetting("outputStyle", name);
                pushSystem(`✓ Output style set to ${name}`);
              }
            }}
            onCancel={() => closeCommandOverlay("Output style picker")}
          />
        );

      case "apikey":
        return (
          <InputDialog
            title="Set API key"
            subtitle={`Provider: ${activeProvider} · saved to ~/.deepseek-code/settings.json`}
            masked
            placeholder="sk-…"
            onSubmit={(key) => {
              setCommandOverlay(null);
              setActiveApiKey(key);
              persistSettings({ apiKey: key });
              pushSystem(
                `✓ API key set (${key.slice(0, 8)}…${key.slice(-4)}) for provider: ${activeProvider}\n✓ Saved to ~/.deepseek-code/settings.json`,
              );
            }}
            onCancel={() => closeCommandOverlay("API key dialog")}
          />
        );

      case "baseurl":
        return (
          <InputDialog
            title="Set base URL"
            subtitle={`Current: ${activeBaseURL || "(default provider URL)"} · empty or "clear" resets`}
            initial={activeBaseURL ?? ""}
            allowEmpty
            placeholder="https://api.deepseek.com/v1"
            onSubmit={(url) => {
              setCommandOverlay(null);
              if (!url || url.toLowerCase() === "clear") {
                setActiveBaseURL(undefined);
                pushSystem("✓ Cleared custom base URL.");
                return;
              }
              setActiveBaseURL(url);
              pushSystem(`✓ Base URL set to: ${url}`);
            }}
            onCancel={() => closeCommandOverlay("Base URL dialog")}
          />
        );

      case "statusline":
        return (
          <InputDialog
            title="Set status line"
            subtitle={`Current: ${statusLineSetting?.command ?? "(not configured)"} · trimmed stdout shows right-aligned on the status bar`}
            initial={statusLineSetting?.command ?? ""}
            allowEmpty
            placeholder="git branch --show-current"
            onSubmit={(command) => {
              setCommandOverlay(null);
              if (!command || command.toLowerCase() === "off") {
                handleUpdateSetting("statusLine", undefined);
                statusLineTextRef.current = null;
                setStatusLineText(null);
                pushSystem("✓ Custom status line cleared.");
                return;
              }
              handleUpdateSetting("statusLine", { type: "command", command });
              statusLineTextRef.current = null;
              setStatusLineText(null);
              pushSystem(
                `✓ Status line set to: ${command}\n(Runs after each turn and every ~20s — output shows right-aligned on the status bar.)`,
              );
            }}
            onCancel={() => closeCommandOverlay("Status line dialog")}
          />
        );

      default:
        return null;
    }
  };

  return (
    <ThemeProvider
      initialState={themeMode}
      onThemeSave={(setting) => handleThemeModeChange(setting)}
    >
    {showOnboarding ? (
      
      
      <Onboarding
        hasApiKey={!!activeApiKey}
        initialTheme={themeMode}
        version="0.1.0"
        onDone={handleOnboardingDone}
      />
    ) : (
    
    
    
    
    <Box flexDirection="column" height={safeTerminalRows(termRows)} minHeight={1}>
      {}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        <ChatPanel
          ref={chatRef}
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
          selection={selection}
          freezeWelcome={
            showSettingsUI || showEffortCallout || showThemePicker || showHelp ||
            exportDialog !== null || searchResults !== null || showHistorySearch ||
            showPluginOverlay || showSessionPicker || commandOverlay !== null ||
            pendingPermission !== null || pendingQuestions !== null
          }
        />
      </Box>

      {}
      {pendingPermission && (
        <PermissionPrompt
          toolName={pendingPermission.toolName}
          description={pendingPermission.description}
          input={pendingPermission.input}
          isTranscriptMode={isTranscriptMode}
          workingDir={workingDirectory}
          explanation={[
            pendingPermission.explanation,
            permissionQueue.length > 1
              ? `${permissionQueue.length - 1} more approval request${permissionQueue.length - 1 === 1 ? "" : "s"} queued`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          onApprove={(value, feedback) => {
            if (value === "__allow_all__") {
              setSessionRules((prev) => ({
                ...prev,
                allow: [...new Set([...prev.allow, "Bash", "PowerShell"])],
              }));
            } else if (value === "__allow_edits__") {
              setSessionRules((prev) => ({
                ...prev,
                allow: [...new Set([...prev.allow, "Edit", "Write", "NotebookEdit"])],
              }));
            } else if (value === "__allow_reads__") {
              setSessionRules((prev) => ({
                ...prev,
                allow: [...new Set([...prev.allow, "FileRead", "Glob", "Grep", "LS"])],
              }));
            } else if (value?.startsWith("__allow_claude_folder__:")) {
              const dir = value.slice("__allow_claude_folder__:".length);
              setSessionRules((prev) => ({
                ...prev,
                allow: [
                  ...prev.allow,
                  `Edit(${escapeRuleContent(dir)}/**)`,
                  `Write(${escapeRuleContent(dir)}/**)`,
                  `NotebookEdit(${escapeRuleContent(dir)}/**)`,
                ],
              }));
            }
            pendingPermission.resolve({ approved: true, feedback });
            setPermissionQueue((prev) => prev.slice(1));
          }}
          onDeny={(feedback) => {
            pendingPermission.resolve({ approved: false, feedback });
            setPermissionQueue((prev) => prev.slice(1));
          }}
        />
      )}

      {pendingQuestions && (
        <AskUserQuestionsPrompt
          questions={pendingQuestions.questions}
          onSubmit={(answers) => {
            pendingQuestions.resolve(answers);
            setPendingQuestions(null);
          }}
          onCancel={() => {
            pendingQuestions.reject(new Error("Questions cancelled by user."));
            setPendingQuestions(null);
          }}
        />
      )}

      {}
      <Box flexShrink={0} flexDirection="column">
      {}
      {isLoading && (
        <Box paddingX={1}>
          <Spinner noun={basename(workingDirectory)} sentiment={spinnerSentiment} />
        </Box>
      )}
      {isLoading && todos.length > 0 && (
        <Box paddingX={2} marginTop={1}>
          <TaskListV2 todos={todos} />
        </Box>
      )}
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
          currentDirectory={workingDirectory}
          onResume={(session) => {
            if (session.workingDirectory === workingDirectory) {
              const loaded = loadSession(session.hash);
              if (loaded) {
                setMessages(loaded.messages.map((m) => ({ ...m, toolUse: [] })));
                setTokenCount(loaded.tokenUsage);
                setActiveSessionHash(loaded.hash);
              }
              setShowSessionPicker(false);
            } else {
              const cmd = `cd ${session.workingDirectory} && deepseek-code --resume ${session.hash}`;
              try {
                const { execSync } = require("child_process");
                execSync(`echo "${cmd}" | pbcopy`);
              } catch {}
              console.log(`\nTo resume session ${session.hash}, change directory to the project folder:\n\n  ${cmd}\n\n(This command has been copied to your clipboard!)`);
              process.exit(0);
            }
          }}
          onRename={(hash, title) => {
            updateSession(hash, { title });
            setSessionsList(listSessions());
          }}
          onClose={() => setShowSessionPicker(false)}
        />
      ) : showSettingsUI ? (
        <Settings defaultTab={settingsTab} onClose={() => setShowSettingsUI(false)} />
      ) : showPluginOverlay ? (
        <PluginPanel
          onClose={() => setShowPluginOverlay(false)}
          onRefreshPlugins={refreshPlugins}
        />
      ) : commandOverlay ? (
        renderCommandOverlay()
      ) : isTranscriptMode ? (
        
        <Box
          borderStyle="single"
          borderTop={true}
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderDimColor
          marginTop={1}
          paddingLeft={2}
          paddingRight={2}
          width="100%"
          alignItems="center"
        >
          <Text dimColor>
            Showing detailed transcript · ↑↓ scroll · <Text bold color="cyan">pgup/pgdn</Text> page · <Text bold color="cyan">g/G</Text> top/bottom · <Text bold color="cyan">ctrl+o</Text>/<Text bold color="cyan">esc</Text>/<Text bold color="cyan">q</Text> to exit
          </Text>
        </Box>
      ) : (
        
        <>
          {}
          {showShortcuts && (
            <ShortcutOverlay
              thinkingMode={thinkingMode}
              mcpCount={mcpCount}
              mcpEnabledCount={mcpEnabledCount}
            />
          )}

          {}
          {queuedSubmissions.length > 0 && (
            <QueuePreview queueItems={queuedSubmissions} />
          )}

          {}
          <TasksStatusPill />

          {}
          {tasksExpanded && <TaskListV2 todos={todos} isStandalone />}

          {}
          {mention && !mentionSuppressed && mentionMatches.length > 0 && (
            <FileMentions matches={mentionMatches} selectedIndex={mentionIndex} query={mention.query} />
          )}

          {}
          <TextInput
            value={input}
            onChange={handleInputChange}
            onSubmit={handleSubmit}
            isLoading={isLoading}
            agentName={currentAgent}
            workingDirectory={workingDirectory}
            recentFiles={currentFile ? [currentFile] : []}
            isBlocked={!!pendingPermission || !!pendingQuestions}
            waitingPermission={!!pendingPermission}
            queueCount={queuedSubmissions.length}
            isPickerActive={showCommandPicker}
          />

          {}
          {showCommandPicker && (
            <CommandPicker
              commands={filteredCommands}
              selectedIndex={Math.min(commandPickerIndex, Math.max(0, filteredCommands.length - 1))}
            />
          )}

          {}
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
            statusLinePadding={statusLineSetting?.padding}
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
    case "Agent":
      return String(args.description || (args.prompt ? String(args.prompt).slice(0, 60) : ""));
    default:
      return JSON.stringify(args);
  }
}
