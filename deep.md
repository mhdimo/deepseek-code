# deep.md

**READ THIS FIRST, DIPSHIT.** This is the project context for DeepSeek Code — the terminal-native AI coding agent you're literally inside right now. If you're about to do anything, know the terrain. Skip this and make a mess? On your own head be it.

## Project overview

DeepSeek Code is a terminal-native AI coding agent built with Bun, Ink (React TUI), and the Vercel AI SDK. It connects to DeepSeek's API (`deepseek-chat`, `deepseek-reasoner`) to provide an interactive AI assistant in your terminal. The agent has built-in tools (Read, Write, Edit, Bash, Glob, Grep, LS, WebFetch, etc.) for file ops, code exploration, and system interaction. You're talking to it right now. Try to keep up.

## Commands

```bash
bun run dev          # Development mode with hot-reload
bun run build        # Build to ./dist/index.js
bun run typecheck    # TypeScript type checking
bun test             # Tests (not configured yet — don't be a hero)
```

## Architecture

```
src/
├── index.tsx           # Entry — loads config, renders Ink <App>
├── Tool.ts             # Tool interface, buildTool(), ToolDef, types
├── tools.ts            # Tool registry + AI SDK adapter
├── types/
│   └── index.ts        # Shared types (Message, QueryEvent, etc.)
├── utils/
│   ├── config.ts       # Config loading: defaults ← file ← env ← CLI
│   └── toolUtils.ts    # Path resolution, diff preview, output formatting
├── state/
│   └── storage.ts      # Session + settings persistence (~/.deepseek-code/)
├── services/
│   ├── provider/
│   │   └── registry.ts # DeepSeek provider adapter + createModel()
│   ├── agent/
│   │   ├── base.ts     # Legacy agent loop (fallback only)
│   │   └── index.ts    # Agent configs (code/plan/review) + AgentManager
│   ├── query.ts        # Streaming query engine — AsyncGenerator agentic loop
│   ├── tokenTracker.ts # Token counting + cost estimation
│   ├── contextManager.ts # Auto-compaction at context limits
│   └── tasks/
│       └── TaskStore.ts # In-memory task store
├── tools/              # One folder per tool, keep it that way
│   ├── FileReadTool/   #   FileReadTool.ts + prompt.ts
│   ├── FileWriteTool/  #   ...
│   ├── FileEditTool/   #   ...
│   ├── BashTool/       #   ...
│   ├── GlobTool/       #   ...
│   ├── GrepTool/       #   ...
│   ├── LS/             #   ...
│   ├── WebFetchTool/   #   ...
│   ├── WebSearchTool/  #   ...
│   ├── NotebookEditTool/ ...
│   ├── TodoWriteTool/  #   ...
│   ├── TaskCreateTool/ ...
│   ├── TaskGetTool/    #   ...
│   ├── TaskUpdateTool/ ...
│   ├── TaskListTool/  #   ...
│   ├── AgentTool/      #   ...
│   ├── AskUserQuestionTool/ ...
│   ├── EnterPlanModeTool/ ...
│   └── ExitPlanModeTool/ ...
└── components/         # Ink React components
    ├── App.tsx         # State management, commands, streaming
    ├── ChatPanel.tsx   # Message rendering + streaming display
    ├── MessageView.tsx # Message rendering with Markdown
    ├── Markdown.tsx    # Rich markdown renderer
    ├── ToolBlock.tsx   # Tool execution display with colors + duration
    ├── StatusBar.tsx   # Model/cost/tokens display
    ├── PermissionPrompt.tsx # Permission UI with diff preview
    ├── TextInput.tsx   # Input wrapper
    ├── MultilineTextInput.tsx # Multi-line input
    ├── CommandPicker.tsx # Slash command suggestions
    ├── ShortcutOverlay.tsx # Keyboard shortcuts
    ├── QueuePreview.tsx # Queued prompts
    ├── Spinner.tsx     # Loading spinner
    ├── WelcomeScreen.tsx # Welcome screen
    └── index.ts        # Barrel exports
```

## Execution flow

1. `src/index.tsx` loads config and renders `<App>`.
2. `App.tsx` manages runtime state (model, agent, messages, thinking mode, permissions).
3. On submit, `query()` creates an AsyncGenerator that:
   - Creates a `LanguageModel` via `createModel(providerConfig)`
   - Gets agent config from `AgentManager.getConfig()`
   - Assembles tools via `getTools()` + `toolsToAISDKFormat()`
   - Runs the streaming agentic loop with retry, auto-compaction, token tracking
4. `processAgentStream()` in App.tsx consumes events and updates React state, yielding between events so Ink can paint.

**DO NOT MESS WITH THIS FLOW.** It works. Don't get clever.

## Key patterns

**Config merging**: `loadConfig()` merges: `DEFAULTS` ← `.deepseek-code.json` ← env vars ← CLI args. Config files support `env:VAR_NAME` references. Legacy `.zcode.json` paths are also checked. We still support that old crap. Whatever.

**Provider**: `createModel(config)` → AI SDK `LanguageModel` via `@ai-sdk/openai`. DeepSeek uses an OpenAI-compatible endpoint at `https://api.deepseek.com/v1`. `registerProviderAdapter()` lets you add custom providers at runtime. Vendor lock-in is for suckers.

**Query engine**: `query()` in `src/services/query.ts` is an `AsyncGenerator<QueryEvent>` that:
- Calls `streamText()` per step, streaming text-delta, reasoning, tool-call, tool-result, token-usage, compact, finish, error
- Loops if the model made tool calls (up to maxSteps)
- Auto-compacts via `ContextManager` at token limits
- Tracks usage and cost via `TokenTracker`
- Retries on 429, 500/503, and network errors with exponential backoff
- Uses AI SDK v6 message format

**Tool system**: Each tool in `src/tools/<ToolName>/` using `buildTool()` with Zod schemas. The registry converts tools to AI SDK format via `zodToJsonSchema()` + `jsonSchema()`. Permission checks per-tool in `checkPermissions()`, `PermissionCallback` passed via `ToolUseContext`. Each tool gets its own folder — don't be a slob.

**Three agents** (in `services/agent/index.ts`):
- `code`: full access, 25 max steps — all gas, no brakes
- `plan`: read-only, 15 max steps — analysis mode (pansy mode)
- `review`: read-only, 15 max steps — code review

**Token tracking**: `TokenTracker` accumulates usage across steps, estimates cost with DeepSeek pricing and cache hit discount. Shown in StatusBar. Money isn't free, genius.

**Context management**: `ContextManager` estimates tokens (~1 token = 4 chars), auto-compacts at 80% of context window, truncates tool outputs, max 30 messages. Context windows are finite. Cry about it.

**Streaming in TUI**: `processAgentStream()` iterates the async generator, calls state setters, yields to renderer between events. On `tool-call-result`, current text + tool blocks finalize as a message, then reset for the next step.

**Permission flow**: Write/Edit/Bash call `requestPermission()` → `pendingPermission` state → `<PermissionPrompt>`. User approves/denies, promise resolves, tool executes. User feedback (Tab on Yes/No) embeds as `💬 User note: ...` in tool result. Permission wait time is subtracted from reported duration.

**Permission UI**: `<PermissionPrompt>` shows diff preview (green = additions, red = deletions). Navigate with arrows, Tab for feedback before confirming.

**Message rendering**: `<MessageView>` uses `<Markdown>` for rich formatting. Each agentic step is a separate message so intermediate text and tool results are visible.

**Zod v4 + AI SDK v6**: Type inference issues between them. Tools typed as `Record<string, any>`, stream options use `as any` casts. **This is intentional.** If you try to "fix" the type safety here, I swear I will reach through your screen. It's ugly. It works. MOVE ON.

## Bun conventions

- Use `bun <file>` — not node, not ts-node. ARE YOU BLIND?
- Use `bun install` — it's faster. Get with it.
- Use `bun test` — whenever we have tests
- Bun loads `.env` automatically — no dotenv required
- Prefer `Bun.file()` over `node:fs` — Bun is right there, USE IT
- This is a TUI, not a web server — no `Bun.serve()`, you absolute cabbage

## Configuration

Priority: CLI args > persisted settings > env vars > `.deepseek-code.json` > defaults

- `DEEPSEEK_API_KEY` — DeepSeek API key (obviously)
- `DEEPSEEK_MODEL` — Model ID (`deepseek-chat` or `deepseek-reasoner`)
- `DEEPSEEK_BASE_URL` — Optional endpoint override (for proxies)

Config file lookup: `.deepseek-code.json` (cwd) → `~/.config/deepseek-code/config.json` → `~/.deepseek-code.json`. See `.deepseek-code.example.json` for the full schema.

## Available Models

- `deepseek-chat` — General-purpose coding assistant (default, does the job)
- `deepseek-reasoner` — Advanced reasoning with extended thinking (overkill but sometimes necessary)
