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
├── index.tsx         # Entry point — loads config, renders Ink <App>
├── core/
│   ├── config.ts     # Config loading (defaults ← file ← env ← CLI)
│   └── types.ts      # All shared types
├── provider/
│   ├── registry.ts   # DeepSeek provider adapter + createModel()
│   └── index.ts      # Public exports
├── agent/
│   ├── base.ts       # Agent class — multi-step agentic loop with tool calling
│   └── index.ts      # Agent configs (code/plan/review) + AgentManager singleton
├── tool/
│   └── index.ts      # Tool definitions (Read, Write, Edit, Bash, Glob, Grep, LS)
└── tui/              # Ink React components
    ├── App.tsx       # Main app — state management, commands, streaming
    ├── ChatPanel.tsx # Message rendering + streaming display
    ├── TextInput.tsx # User input
    └── ...           # StatusBar, ToolBlock, PermissionPrompt, etc.
```

### Execution flow

1. `src/index.tsx` loads config (defaults ← file ← env ← CLI) and renders `<App>`
2. `App.tsx` manages runtime state (model, agent, messages, thinking mode, permissions)
3. On message submit, `AgentManager.createAgent()` creates an `Agent` with the current agent config and provider
4. `Agent.run()` streams `AgentEvent` objects: text deltas, thinking, tool calls
5. `processAgentStream()` in App.tsx consumes events and updates React state, yielding to the renderer between events so Ink can paint

### Key patterns

**Config merging**: `loadConfig()` merges: `DEFAULTS` ← `.deepseek-code.json` ← env vars ← CLI args. Config files support `env:VAR_NAME` references for secrets (resolved at load time). Legacy paths like `.zcode.json` are also checked.

**Provider**: `createModel(config)` → AI SDK `LanguageModel` via `@ai-sdk/openai`. DeepSeek uses an OpenAI-compatible endpoint at `https://api.deepseek.com/v1`. `registerProviderAdapter()` allows adding custom providers at runtime.

**Agent loop**: `Agent.run()` is an `AsyncGenerator<AgentEvent>`. It calls `streamText()` per step, streams events (text-delta, reasoning, tool-call, tool-result, finish, error), and loops if the model made tool calls. History is truncated to the last 30 messages. AI SDK v6 message format is used: assistant messages use `{ type: "tool-call", input }` parts, tool results use `{ type: "tool-result", output: { type: "text", value } }` parts.

**Tool system**: `createTools(workingDir, permissions, requestPermission)` returns a `Record<string, any>` of tool definitions. Tools use `jsonSchema()` for parameters (not Zod) for DeepSeek API compatibility. Write/Edit/Bash tools prompt for user permission via the `PermissionCallback`.

**Three agents** (defined in `agent/index.ts`):
- `code`: full access (read + write + execute), 25 max steps
- `plan`: read-only, 15 max steps — analysis and planning
- `review`: read-only, 15 max steps — code review

**Streaming in TUI**: `processAgentStream()` in App.tsx iterates the async generator and calls `setStreamingText`/`setStreamingToolUse` etc. A `yieldToRenderer()` (setTimeout 0) between events lets Ink paint updates. On `tool-call-result`, streaming text resets for the next agentic step.

**Permission flow**: Write/Edit/Bash call `requestPermission()` which sets `pendingPermission` state, rendering `<PermissionPrompt>`. The user approves/denies, resolving the promise that unblocks tool execution.

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
