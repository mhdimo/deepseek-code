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

## Architecture

```
src/
├── index.tsx         # Entry point — loads config, renders Ink app
├── core/
│   ├── config.ts     # Config loading (env, CLI args, .deepseek-code.json)
│   └── types.ts      # All shared types (DeepSeekCodeConfig, Message, AgentEvent, etc.)
├── provider/
│   ├── registry.ts   # DeepSeek provider adapter + createModel()
│   └── index.ts      # Public exports
├── agent/
│   ├── base.ts       # Agent class — multi-step agentic loop with tool calling
│   └── index.ts      # Public exports
├── tool/
│   └── index.ts      # Tool definitions (Read, Write, Edit, Bash, Glob, Grep, LS)
└── tui/              # Ink React components
    ├── App.tsx       # Main app — state management, command handling
    ├── ChatPanel.tsx # Message rendering
    ├── TextInput.tsx # User input
    └── ...           # Other UI components
```

### Execution flow

1. `src/index.tsx` loads config (env vars → CLI args → `.deepseek-code.json`) and renders `<App>`
2. `App.tsx` manages runtime state (model, agent, messages, thinking mode)
3. On message submit, `Agent.run()` streams events: text deltas, thinking, tool calls
4. TUI consumes events and updates the display

### Key patterns

**Provider abstraction**: `DeepSeekCodeConfig` → `createModel(config)` → AI SDK `LanguageModel`. Uses DeepSeek's OpenAI-compatible endpoint.

**Agent loop**: `Agent.run()` yields `AgentEvent` objects (`text-delta`, `tool-call-start`, `tool-call-result`, `finish`, `error`). The loop continues until no tool calls or `maxSteps` reached.

**Tool system**: `createTools(workingDir, permissions, requestPermission)` returns AI SDK-compatible tool definitions. Tools are permission-gated and can prompt for user approval.

**Zod v4 + AI SDK v6**: This project uses Zod v4 with AI SDK v6. There are type inference issues between them — tools are typed as `Record<string, any>` and stream options use `as any` casts. This is intentional.

## Bun conventions

- Use `bun <file>` instead of `node` or `ts-node`
- Use `bun install` instead of npm/yarn/pnpm
- Use `bun test` instead of jest/vitest
- Bun auto-loads `.env` files — no dotenv needed
- Prefer `Bun.file()` over `node:fs` readFile/writeFile for new code
- This is a TUI app, not a web server — don't use `Bun.serve()`

## Configuration

Config sources (priority: CLI args > env vars > `.deepseek-code.json`):

- `DEEPSEEK_API_KEY` — DeepSeek API key
- `DEEPSEEK_MODEL` — Model ID (`deepseek-chat` or `deepseek-reasoner`)
- `DEEPSEEK_BASE_URL` — optional endpoint override (for proxies)

See `.deepseek-code.example.json` for full config file structure including profiles and MCP servers.

## Available Models

- `deepseek-chat` — General-purpose coding assistant (default)
- `deepseek-reasoner` — Advanced reasoning with extended thinking
