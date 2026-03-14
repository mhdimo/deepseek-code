# MCP in z-code

This document explains how MCP works in z-code today, how to configure it, and what is planned.

## Current state

z-code currently provides:

- MCP server configuration in `.zcode.json`
- MCP visibility in the TUI (`/mcp`)
- MCP runtime toggling in the TUI (`/mcp enable <name>`, `/mcp disable <name>`)
- MCP status in the shortcut panel and status bar

z-code does **not yet** execute MCP protocol calls against servers in the agent loop.

In short: **configuration + UX are implemented, full tool-bridging is the next step**.

---

## Configuration

Add `mcpServers` in `.zcode.json`:

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "apiKey": "env:OPENAI_API_KEY",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true
    },
    "git": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git"],
      "enabled": false
    }
  }
}
```

### MCP server fields

- `command`: executable to run
- `args`: argument array
- `cwd`: optional working directory for the server process
- `env`: optional environment map (`"env:NAME"` is supported)
- `enabled`: optional boolean, defaults to enabled

---

## Runtime commands

- `/mcp` (or `/mcp list`) — list configured servers
- `/mcp enable <name>` — enable one server
- `/mcp disable <name>` — disable one server

These commands update in-memory session state.

---

## Roadmap (recommended next implementation)

1. Add an `MCPManager` that starts/stops stdio MCP processes.
2. Pull tool schemas from MCP servers.
3. Convert MCP tools to AI SDK tools at runtime.
4. Route tool calls through the manager and stream results.
5. Persist enabled/disabled state to session file.

This keeps z-code modular and compatible with any MCP server ecosystem.
