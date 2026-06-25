# DeepSeek Code

A terminal-native AI coding agent — powered by DeepSeek, with multi-agent workflows, tool execution, and MCP extensibility.

## Features

- Native terminal UI built with Ink (React)
- Autonomous multi-step agent loop with 19 built-in tools
- DeepSeek models: `deepseek-chat` and `deepseek-reasoner`
- Switch models, profiles, and agents on the fly
- MCP server support — configure, toggle, and monitor in-app

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

## Quick setup

You can configure via environment variables or `.deepseek-code.json`.

### Environment variables

```bash
export DEEPSEEK_API_KEY="..."
export DEEPSEEK_MODEL="deepseek-chat"  # or deepseek-reasoner
export DEEPSEEK_BASE_URL="https://api.deepseek.com/v1"  # optional, for proxies
```

### .deepseek-code.json

Copy [.deepseek-code.example.json](.deepseek-code.example.json) and edit values.

The config file supports:

- default model and API key
- named profiles for different model setups
- MCP server definitions

---

## Available Models

- `deepseek-chat` - General-purpose coding assistant (default)
- `deepseek-reasoner` - Advanced reasoning for complex tasks

---

## MCP

DeepSeek Code supports the Model Context Protocol for extending capabilities:

- Define `mcpServers` in `.deepseek-code.json`
- `/mcp` command to view and toggle servers at runtime
- Active MCP servers displayed in the status bar

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
- UI: Ink (React TUI)
- Agent engine: ai-sdk-cpp (native C++)

For code structure and data flow, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT
