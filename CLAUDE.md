# CLAUDE.md

**Welcome, friend!** This file documents the codebase for DeepSeek Code — a terminal-native AI coding agent. Thanks for being here. Reading this first will set you up for success. Let's build something great together!

## Project overview

DeepSeek Code is a terminal-native AI coding agent built with Bun, Ink (React TUI), and the **ai-sdk-cpp** native engine (a C++ SDK via its Node binding — no Vercel AI SDK here anymore). It connects to DeepSeek's API (`deepseek-chat`, `deepseek-reasoner`) to provide an interactive AI assistant in the terminal. The agent has built-in tools (Read, Write, Edit, Bash, Glob, Grep, LS, WebFetch, Skill, and more) for file manipulation, code exploration, and system interaction. The UI layer (theme, design system, components) is ported from Claude Code's frontend. You've got this!

## Commands

```bash
bun run dev          # Development mode (hot-reload via Ink)
bun run build        # Build executable to ./dist/index.js (+ copies bundled skills to dist/bundled)
bun run typecheck    # TypeScript type checking (no emit)
bun test             # Tests (not configured yet — contributions welcome!)

bun dist/index.js --version                      # Print version (verifies the native addon loads)
bun dist/index.js --effort high                  # Launch with reasoning effort (off|low|medium|high|max)
bun dist/index.js --print "fix the tests"        # Headless: run one prompt, print, exit (CI/scripts)
bun dist/index.js -p --output-format json --max-turns 20   # Same, JSON envelope for automation
```

## Architecture

```
src/
├── index.tsx           # Entry — loads config, safety gates, --print branch, renders Ink <App>
├── Tool.ts             # Core Tool interface, buildTool(), ToolDef, ToolUseContext
├── tools.ts            # Tool registry + binding adapter (getAllBaseTools, toolsToBindingFormat)
│                       #   + permission-rule engine hook-in + plan-mode gate
├── Task.ts             # Background-task state model (used by services/tasks/)
├── types/
│   └── index.ts        # All shared types (Message, MessageBlock, QueryEvent, TokenUsage, etc.)
├── cli/
│   └── print.ts        # Headless --print mode — drives the SAME Agent/Session as the TUI
├── constants/
│   ├── help.ts         # /help command data (HelpView renders this)
│   ├── prompts.ts      # assembleSystemPromptSync() — dynamic system prompt per agent
│   └── files.ts        # Extension/path helpers
├── skills/
│   ├── skillService.ts # SKILL.md discovery (project > user > bundled) + frontmatter parsing
│   └── bundled/        # Ships with the app: code-review, git-commit, debugging (copied to dist)
├── utils/
│   ├── config.ts       # Config loading (defaults ← file ← env ← CLI, incl. --effort/--print)
│   ├── theme.ts        # Claude-Code-style theme module: getTheme()/Theme/resolveColor +
│   │                   #   legacy mutable `theme` palette kept in sync by setThemeMode()
│   ├── toolUtils.ts    # Path resolution, buildSystemInstructions(), diff preview, formatting
│   ├── fileHistory.ts  # /rewind file snapshots (per-message on-disk state)
│   ├── notify.ts       # Desktop notifications + preventSleep (Bun.spawn, platform-detected)
│   ├── exportConversation.ts # /export markdown/json writer
│   ├── transcriptSearch.ts  # /search full-transcript matching
│   └── …               # costSummary, credentials, cron, fuzzy, limits, migrations, onboarding…
├── state/
│   └── storage.ts      # Session + settings persistence (~/.deepseek-code/) — incl. `effort`
├── services/
│   ├── provider/registry.ts  # createModel() → ai-sdk-cpp native Model (OpenAI-compatible)
│   ├── agent/
│   │   ├── agentSession.ts   # getOrCreateMemorySession() — builds the native Agent+Session
│   │   │                     #   (cache key includes effort; system prompt + memory + output style)
│   │   ├── base.ts           # TS-side Agent class — used by AgentManager + AgentTool fallback
│   │   └── index.ts          # Agent configs (code/plan/review) + AgentManager singleton
│   ├── query.ts        # Maps native StreamEvents → QueryEvent (text/thinking/tool/finish/error)
│   ├── effort.ts       # Reasoning effort: getEffortLevel() + effortToProviderOptions()
│   ├── permissions.ts  # Tool(spec:pattern) allow/deny/ask rule engine
│   ├── recovery.ts     # Error classification: 413 → /compact advice; overload → fallback retry
│   ├── hooks.ts        # PreToolUse / PostToolUse / UserPromptSubmit / Stop / Notification hooks
│   ├── projectTrust.ts # Workspace trust gate (gates /statusline execution)
│   ├── scheduler.ts    # Cron scheduling for ScheduleCronTool
│   ├── tokenTracker.ts # Token counting + cost estimation per session
│   ├── contextManager.ts # Tracks C++-reported usage, warns near context limits (1M window)
│   └── tasks/
│       ├── backgroundFramework.ts # Background shell-task registry (registerTask/readOutput/kill)
│       └── TaskStore.ts # In-memory TODO task store
├── ui/
│   └── design-system/  # ThemeProvider, ThemedText, ThemedBox, Divider, StatusIcon, ProgressBar
└── components/         # Ink React components (Claude-Code-style ports)
    ├── App.tsx         # Main app — state, commands, streaming, overlays
    ├── ChatPanel.tsx   # Message rendering + streaming display
    ├── MessageView.tsx # Individual message rendering (text/tool/thinking blocks)
    ├── Markdown.tsx    # Rich markdown renderer (dependency-free hand-rolled parser)
    ├── ThinkingBlock.tsx # Collapsed '∴ Thought' block (ctrl+o expands to transcript mode)
    ├── ToolBlock.tsx   # Tool execution display with colors + duration + structured diff
    ├── StatusBar.tsx   # Model/effort/context/tokens display + custom /statusline output
    ├── PermissionPrompt.tsx # Permission approval UI with diff preview
    ├── TextInput.tsx / MultilineTextInput.tsx # Input components
    ├── CommandPicker.tsx / ShortcutOverlay.tsx / QueuePreview.tsx
    ├── Spinner.tsx / WelcomeScreen.tsx (ASCII whale mascot)
    ├── HelpView.tsx / ExportView.tsx / SearchResultsView.tsx / HistorySearch.tsx
    └── index.ts        # Barrel exports
```

## Execution flow

1. `src/index.tsx` loads config (defaults ← file ← env ← CLI), enforces the root/sudo bypass gate, branches to `--print` headless mode when requested, then renders `<App>`
2. `App.tsx` manages runtime state (model, agent, messages, thinking, effort, permissions, overlays)
3. On message submit, the native **Agent + Session** (via `getOrCreateMemorySession()` in `agentSession.ts`) own the agentic loop: history, memory auto-inject, sliding-window compaction, retries, and max-steps. The binding streams events back (text, reasoning, tool calls, step finish, finish, error)
4. `processAgentStream()` in App.tsx consumes those events (through `query()`'s `QueryEvent` mapping), batches them into ~80ms flushes for the renderer, and appends text/thinking/tool blocks chronologically

**This flow is well-designed and tested.** Trust it, and it will serve you well.

## Key patterns

**Native engine (ai-sdk-cpp)**: The heavy lifting lives in the C++ SDK — the TS side builds an `Agent` (model + tools + instructions + providerOptions) and a `Session` (memory dir, context budget) and drives it with `session.sendStream()`. Do NOT reimplement the loop, streaming, or compaction in TS. `src/services/query.ts` only maps native events to UI events.

**Config merging**: `loadConfig()` merges: `DEFAULTS` ← `.deepseek-code.json` ← env vars ← CLI args. Config files support `env:VAR_NAME` references for secrets (resolved at load time). Legacy paths like `.zcode.json` are also checked because backwards compatibility matters and we care about our users.

**Provider**: `createModel(config)` → ai-sdk-cpp native Model. DeepSeek uses an OpenAI-compatible endpoint at `https://api.deepseek.com/v1`. Keep the provider abstraction in `services/provider/registry.ts` — flexibility and choice are wonderful things.

**Reasoning effort**: `--effort <off|low|medium|high|max>` (CLI flag, persisted setting, or config key) flows through `services/effort.ts` → `providerOptions.openai.reasoningEffort` on the native Agent. Effort is part of the session cache key, so changing it rebuilds the session on the next message. The StatusBar shows an effort chip (○/◐/●/◉). "off"/unset sends nothing — unchanged behavior.

**Skills system**: `src/skills/skillService.ts` discovers `SKILL.md` from project `.claude/skills/`, user `~/.claude/skills/`, and bundled `src/skills/bundled/` (project > user > bundled precedence). `SkillTool` is model-invokable — its description embeds the skill listing, and invoking it returns the SKILL.md body. `bun run build` copies bundled skills to `dist/bundled`; the built binary resolves them via `import.meta.dir`. Use `/skills <name>` to view one, `/skills` to list.

**Thinking blocks**: Reasoning streams as chronological, collapsed blocks — `∴ Thinking…` with a dim preview while streaming, `∴ Thought (ctrl+o to expand)` once finalized. Ctrl+O toggles transcript mode (full text, all blocks expanded). `MessageBlock` has `type: "thinking"`; App tracks the open block via `thinkingOpenRef` (reasoning_start → delta → end). Legacy transcripts still render via `message.thinking`.

**Headless / --print mode**: `src/cli/print.ts` runs one prompt against the same Agent/Session and prints text (or a JSON envelope) to stdout without rendering Ink. Flags: `--print [prompt]` (stdin if no arg), `--output-format text|json`, `--max-turns`, `--system-prompt-file`, `--stream`, `--verbose`. Permissions auto-approve (headless); index.tsx refuses `--dangerously-skip-permissions` as root outside a sandbox.

**Tool system**: Each tool lives in its own directory under `src/tools/<ToolName>/` using `buildTool()` from `Tool.ts` with Zod schemas. The registry (`src/tools.ts`) adapts them for the binding and wires the permission pipeline. Registered tools include: FileRead (with PDF/notebook/image support), FileWrite, FileEdit, Bash (with `run_in_background` → background-task registry), Glob, Grep (rich rg-based with output_mode/context/multiline), LS, WebFetch, WebSearch, NotebookEdit, TodoWrite, TaskCreate/Get/Update/List, Agent, AskUserQuestion, Enter/ExitPlanMode, Config, Sleep, ScheduleCron, Enter/ExitWorktree, PowerShell, Brief, REPL, ToolSearch, TaskOutput, TaskStop, and Skill. Keep each tool in its own folder — organization makes everyone happy!

**Permission engine**: `src/services/permissions.ts` parses `settings.permissions` rules in `Tool(spec:pattern)` syntax (allow/deny/ask). The tools.ts execute wrapper consults rules FIRST (a global deny hard-blocks without prompting; a global allow auto-approves), then falls through to the per-tool `checkPermissions()` and the interactive `<PermissionPrompt>` with diff preview. Plan mode denies write/execute tools. User feedback (Tab on Yes/No) is embedded in the tool result as `💬 User note: ...` so the model sees it immediately.

**Background tasks**: `BashTool(run_in_background: true)` registers the process via `src/services/tasks/backgroundFramework.ts` (process-group SIGTERM→SIGKILL kill semantics). The model reads tails with `TaskOutput` and kills with `TaskStop`.

**Recovery**: `src/services/recovery.ts` classifies engine errors — 413/prompt-too-long → advise `/compact` or `/clear`; overload (429) → one-shot retry against a fallback model (`DEEPSEEK_FALLBACK_MODEL` env or the first other profile) — never more than once per user turn.

**Three agents** (defined in `services/agent/index.ts`):
- `code`: full access (read + write + execute), 25 max steps — full speed ahead!
- `plan`: read-only, 15 max steps — thoughtful analysis and planning
- `review`: read-only, 15 max steps — thorough code review

**Token tracking**: `TokenTracker` (src/services/tokenTracker.ts) accumulates usage and estimates cost with DeepSeek pricing. `ContextManager` tracks the C++-reported cumulative usage (deepseek models default to a 1M context window), drives the StatusBar context bar, and warns once when approaching the limit. The C++ session owns compaction — the TS side must NOT compact messages.

**Streaming in TUI**: `processAgentStream()` in App.tsx consumes the event stream, keeps refs as the source of truth, and batches state updates into ~80ms flushes (via `scheduleStreamingFlush()`/`yieldToRenderer()`). Text, thinking, and tool blocks accumulate chronologically in `streamingBlocksRef`; on step finish they're finalized into history and streaming state resets. `incrementalRendering` stays OFF for Ink — full erase+redraw avoids input-refresh desyncs.

**Frontend port**: The UI is ported from Claude Code's frontend onto stock Ink. `src/utils/theme.ts` exports `getTheme(name)` → `Theme` (dark/light/ansi palettes), `resolveColor(token)` (handles `ansi:` notation), plus the legacy mutable `theme` object kept in sync via `setThemeMode()`. `src/ui/design-system/` provides `ThemeProvider` (context; 'auto' resolves via `$COLORFGBG`), `ThemedText`, `ThemedBox`, `Divider`, `StatusIcon`, `ProgressBar`. Ported components render through these tokens. No fork-ink imports — stock `ink` only.

**Hooks**: `src/services/hooks.ts` runs user-configured shell hooks (PreToolUse blocks via exit code 2 or a JSON decision; PostToolUse, UserPromptSubmit, Stop, Notification are fire-and-forget). Config in `~/.deepseek-code/settings.json` under "hooks".

**Custom status line**: `/statusline <command>` runs a command (trust-gated by `projectTrust.isTrusted()`, 5s timeout, 300ms debounce, ~20s refresh) and shows its trimmed stdout at the far right of the StatusBar. `/statusline off` clears it.

**Commands**: /help /model /models /agent /apikey /baseurl /think /effort /skills /export /search /rewind /history /sessions /resume /clear /compact /mcp /hooks /tools /shortcuts /statusline /setup /queue /cost /usage /settings /status /config /stats /copy /diff /pr /commit /plugin(s) /doctor /messages /exit. Command data lives in `src/constants/help.ts` — add new commands there too, or /help drifts.

## Bun conventions

- Use `bun <file>` instead of `node` or `ts-node` — it's fast and modern!
- Use `bun install` instead of npm/yarn/pnpm — enjoy the speed
- Use `bun test` when we finally have tests (contributions welcome!)
- Bun auto-loads `.env` files — no dotenv required, how convenient!
- Prefer `Bun.file()` over `node:fs` readFile/writeFile for new code
- This is a TUI app, not a web server — let's leave `Bun.serve()` for the web folks

## Configuration

Config sources (priority: CLI args > persisted settings > env vars > `.deepseek-code.json` > defaults):

- `DEEPSEEK_API_KEY` — DeepSeek API key (required to get started)
- `DEEPSEEK_MODEL` — Model ID (`deepseek-chat` or `deepseek-reasoner`)
- `DEEPSEEK_BASE_URL` — Optional endpoint override (handy for proxies)
- `DEEPSEEK_FALLBACK_MODEL` — Optional fallback model for overload (429) recovery
- `effort` — Reasoning effort: `off|low|medium|high|max` (config key, persisted setting, or `--effort` flag)

Config file lookup order: `.deepseek-code.json` (cwd) → `~/.config/deepseek-code/config.json` → `~/.deepseek-code.json`. See `.deepseek-code.example.json` for the full schema including profiles and MCP servers.

## Available Models

- `deepseek-chat` — General-purpose coding assistant (default, always reliable)
- `deepseek-reasoner` — Advanced reasoning with extended thinking (powerful when you need that extra oomph)
