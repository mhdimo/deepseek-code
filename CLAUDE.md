# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

DeepSeek Code is a terminal-native AI coding agent built with Bun + Ink (React TUI) + Vercel AI SDK. It uses DeepSeek's API (deepseek-chat, deepseek-reasoner) and includes built-in tools (Read, Write, Edit, Bash, Glob, Grep, LS).

## Commands

```bash
bun run dev          # Run in development mode
bun run build        # Build executable to ./dist/index.js
bun run typecheck    # TypeScript type check (no emit)
bun test             # Run tests (when present)
```

No test framework is configured yet — `bun test` will work once tests are added.

## Architecture

```
src/
├── index.tsx           # Entry point — loads config, renders Ink <App>
├── Tool.ts             # Core Tool interface, buildTool(), ToolDef, Types
├── tools.ts            # Tool registry + AI SDK adapter (getAllBaseTools, getTools, toolsToAISDKFormat)
├── types/
│   └── index.ts        # All shared types (Message, AgentEvent, QueryEvent, etc.)
├── utils/
│   ├── config.ts       # Config loading (defaults ← file ← env ← CLI)
│   └── toolUtils.ts    # Shared helpers (path resolution, diff preview, output formatting)
├── state/
│   └── storage.ts      # Session + settings persistence (~/.deepseek-code/)
├── services/
│   ├── provider/
│   │   └── registry.ts # DeepSeek provider adapter + createModel()
│   ├── agent/
│   │   ├── base.ts     # Agent class — legacy agentic loop (kept as fallback)
│   │   └── index.ts    # Agent configs (code/plan/review) + AgentManager singleton
│   ├── query.ts        # Streaming query engine — AsyncGenerator-based agentic loop
│   ├── tokenTracker.ts # Token counting + cost estimation per session
│   ├── contextManager.ts # Auto-compaction when approaching context limits
│   └── tasks/
│       └── TaskStore.ts # In-memory task store
├── tools/
│   ├── FileReadTool/
│   │   ├── FileReadTool.ts
│   │   └── prompt.ts
│   ├── FileWriteTool/ ...
│   ├── FileEditTool/ ...
│   ├── BashTool/ ...
│   ├── GlobTool/ ...
│   ├── GrepTool/ ...
│   ├── LS/ ...
│   ├── WebFetchTool/ ...
│   ├── WebSearchTool/ ...
│   ├── NotebookEditTool/ ...
│   ├── TodoWriteTool/ ...
│   ├── TaskCreateTool/ ...
│   ├── TaskGetTool/ ...
│   ├── TaskUpdateTool/ ...
│   ├── TaskListTool/ ...
│   ├── AgentTool/ ...
│   ├── AskUserQuestionTool/ ...
│   ├── EnterPlanModeTool/ ...
│   └── ExitPlanModeTool/ ...
└── components/         # Ink React components
    ├── App.tsx         # Main app — state management, commands, streaming
    ├── ChatPanel.tsx   # Message rendering + streaming display
    ├── MessageView.tsx # Individual message rendering with Markdown
    ├── Markdown.tsx    # Rich markdown renderer (bold, italic, code, lists, etc.)
    ├── ToolBlock.tsx   # Tool execution display with colors + duration
    ├── StatusBar.tsx   # Model/cost/tokens display
    ├── PermissionPrompt.tsx # Permission approval UI with diff preview
    ├── TextInput.tsx   # Input wrapper
    ├── MultilineTextInput.tsx # Multi-line input
    ├── CommandPicker.tsx # Slash command suggestions
    ├── ShortcutOverlay.tsx # Keyboard shortcuts
    ├── QueuePreview.tsx # Queued prompts
    ├── Spinner.tsx     # Loading spinner
    ├── WelcomeScreen.tsx # Initial welcome screen
    └── index.ts        # Barrel exports
```

### Execution flow

1. `src/index.tsx` loads config (defaults ← file ← env ← CLI) and renders `<App>`
2. `App.tsx` manages runtime state (model, agent, messages, thinking mode, permissions)
3. On message submit, `query()` creates an AsyncGenerator that:
   - Creates a `LanguageModel` via `createModel(providerConfig)`
   - Gets the agent config from `AgentManager.getConfig()`
   - Assembles tools via `getTools()` + `toolsToAISDKFormat()`
   - Runs the streaming agentic loop with retry, auto-compaction, token tracking
4. `processAgentStream()` in App.tsx consumes events and updates React state, yielding to the renderer between events so Ink can paint

### Key patterns

**Config merging**: `loadConfig()` merges: `DEFAULTS` ← `.deepseek-code.json` ← env vars ← CLI args. Config files support `env:VAR_NAME` references for secrets (resolved at load time). Legacy paths like `.zcode.json` are also checked.

**Provider**: `createModel(config)` → AI SDK `LanguageModel` via `@ai-sdk/openai`. DeepSeek uses an OpenAI-compatible endpoint at `https://api.deepseek.com/v1`. `registerProviderAdapter()` allows adding custom providers at runtime.

**Query engine**: `query()` is the main entry point in `src/services/query.ts`. It's an `AsyncGenerator<QueryEvent>` that:
- Calls `streamText()` per step, streaming events (text-delta, reasoning, tool-call, tool-result, token-usage, compact, finish, error)
- Loops if the model made tool calls (up to maxSteps)
- Auto-compacts via `ContextManager` when approaching token limits
- Tracks token usage and cost via `TokenTracker`
- Retries on rate-limit (429), server errors (500/503), and network errors with exponential backoff
- AI SDK v6 message format is used: assistant messages use `{ type: "tool-call", input }` parts, tool results use `{ type: "tool-result", output: { type: "text", value } }` parts

**Tool system**: Each tool is in its own directory under `src/tools/<ToolName>/` using `buildTool()` from `Tool.ts` with Zod schemas internally. The registry (`src/tools.ts`) converts tools to AI SDK format via `zodToJsonSchema()` + `jsonSchema()` for DeepSeek API compatibility. Permission checks happen per-tool in `checkPermissions()`, and the `PermissionCallback` is passed via `ToolUseContext`.

**Three agents** (defined in `services/agent/index.ts`):
- `code`: full access (read + write + execute), 25 max steps
- `plan`: read-only, 15 max steps — analysis and planning
- `review`: read-only, 15 max steps — code review

**Token tracking**: `TokenTracker` (src/services/tokenTracker.ts) accumulates token usage across steps and estimates cost using DeepSeek pricing (with cache hit discount). Displayed in StatusBar via `formatTokenCount()` and `formatCost()`.

**Context management**: `ContextManager` (src/services/contextManager.ts) estimates token usage (1 token ≈ 4 chars), auto-compacts when usage exceeds 80% of model context window, truncates tool outputs, and prepares messages for API calls (max 30 messages).

**Streaming in TUI**: `processAgentStream()` in App.tsx iterates the async generator and calls `setStreamingText`/`setStreamingToolUse` etc. A `yieldToRenderer()` (setTimeout 0) between events lets Ink paint updates. On `tool-call-result`, the current text + tool blocks are finalized as a message in history, then streaming state resets for the next agentic step.

**Permission flow**: Write/Edit/Bash call `requestPermission()` which sets `pendingPermission` state, rendering `<PermissionPrompt>`. The user approves/denies, resolving the promise that unblocks tool execution. User feedback (via Tab on Yes/No) is embedded directly in the tool result as `💬 User note: ...`, so the model sees it immediately. Permission wait time is subtracted from the reported tool duration.

**Permission prompt UI**: `<PermissionPrompt>` shows a diff preview with green background for additions (+) and red background for deletions (-). Options are navigable with arrow keys. Press Tab on Yes/No to add feedback before confirming.

**Message rendering**: `<MessageView>` renders assistant messages using `<Markdown>` for rich formatting (bold, italic, code blocks, lists, headings, blockquotes). Each agentic step is saved as a separate message so intermediate model text and tool results are visible during multi-step runs.

**Zod v4 + AI SDK v6**: There are type inference issues between them — tools are typed as `Record<string, any>` and stream options use `as any` casts. This is intentional.

## Bun conventions

- Use `bun <file>` instead of `node` or `ts-node`
- Use `bun install` instead of npm/yarn/pnpm
- Use `bun test` instead of jest/vitest
- Bun auto-loads `.env` files — no dotenv needed
- Prefer `Bun.file()` over `node:fs` readFile/writeFile for new code
- This is a TUI app, not a web server — don't use `Bun.serve()`

## Configuration

Config sources (priority: CLI args > persisted settings > env vars > `.deepseek-code.json` > defaults):

- `DEEPSEEK_API_KEY` — DeepSeek API key
- `DEEPSEEK_MODEL` — Model ID (`deepseek-chat` or `deepseek-reasoner`)
- `DEEPSEEK_BASE_URL` — optional endpoint override (for proxies)

Config file lookup order: `.deepseek-code.json` (cwd) → `~/.config/deepseek-code/config.json` → `~/.deepseek-code.json`. See `.deepseek-code.example.json` for the full schema including profiles and MCP servers.

## Available Models

- `deepseek-chat` — General-purpose coding assistant (default)
- `deepseek-reasoner` — Advanced reasoning with extended thinking
