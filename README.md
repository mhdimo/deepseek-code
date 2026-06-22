# DeepSeek Code

Terminal-native AI coding agent powered by DeepSeek, with multi-agent workflow and MCP extensibility.

## Features

- Fast terminal interaction (Ink-based TUI)
- Multi-step coding agent loop with tool execution
- DeepSeek API integration (deepseek-chat, deepseek-reasoner)
- Model/profile switching at runtime
- MCP server discovery/status UX in-app

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Agents](docs/AGENTS.md)
- [MCP usage](docs/MCP.md)
- [Example config](.deepseek-code.example.json)

---

## Install

```bash
git clone https://github.com/your-repo/deepseek-code.git
cd deepseek-code
bun install
```

## Run

```bash
bun run dev
```

## Build

```bash
bun run build
```

---

## Quick configuration

You can configure via environment variables or `.deepseek-code.json`.

### Environment variables

```bash
export DEEPSEEK_API_KEY="..."
export DEEPSEEK_MODEL="deepseek-chat"  # or deepseek-reasoner
export DEEPSEEK_BASE_URL="https://api.deepseek.com/v1"  # optional, for proxies
```

### .deepseek-code.json

Copy [.deepseek-code.example.json](.deepseek-code.example.json) and edit values.

Supports:

- base model/key
- named `profiles`
- `mcpServers`

---

## Available Models

- `deepseek-chat` - General-purpose coding assistant (default)
- `deepseek-reasoner` - Advanced reasoning for complex tasks

---

## MCP

Current MCP scope in DeepSeek Code:

- Configurable `mcpServers` in `.deepseek-code.json`
- `/mcp` command for visibility and toggling
- MCP status shown in UI

See [docs/MCP.md](docs/MCP.md) for examples and roadmap.

---

## Useful in-app commands

- `/help`
- `/setup`
- `/model`, `/models`
- `/apikey`
- `/agent`
- `/think`
- `/mcp`
- `/shortcuts`

Type `/` to open the command picker. Use arrows to navigate.

---

## Developer notes

- Runtime: Bun
- Language: TypeScript
- UI: Ink
- Model layer: AI SDK

For code structure and data flow, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT
