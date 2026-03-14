# z-code architecture

## High-level modules

- [src/core](../src/core): shared types + config loading
- [src/provider](../src/provider): model/provider abstraction
- [src/agent](../src/agent): agent orchestration + streaming loop
- [src/tool](../src/tool): built-in local tools (Read/Edit/Bash/etc.)
- [src/tui](../src/tui): terminal UI (Ink), command picker, status panels

## Execution flow

1. `src/index.tsx` loads config and starts the Ink app.
2. `App.tsx` manages runtime state (provider/model/agent/thinking).
3. On submit, `agentManager.createAgent()` creates an `Agent`.
4. `Agent.run()` streams events:
   - text deltas
   - thinking deltas
   - tool call start/result
   - finish/error
5. App consumes events and updates TUI.

## Provider flow

1. `ProviderConfig` is built from mutable runtime state.
2. `createModel(config)` resolves adapter by provider type.
3. Adapter returns AI SDK `LanguageModel`.

This keeps provider-specific code out of the agent and UI.

## MCP flow (current)

1. Config parser loads `mcpServers` from `.zcode.json`.
2. App tracks MCP server enabled/disabled state.
3. `/mcp` commands expose status and toggling.

Protocol-level MCP tool execution is planned, not fully wired yet.

## Why this structure scales

- Providers are adapter-driven.
- UI commands are centralized in `App.tsx`.
- Tooling layer is independent from provider layer.
- MCP can be added as a new integration layer without touching provider adapters.
