# z-code

Terminal-native AI coding agent with a Claude-like UX, multi-agent workflow, and provider/MCP extensibility.

## What z-code focuses on

- Fast terminal interaction (Ink-based TUI)
- Multi-step coding agent loop with tool execution
- OpenAI-compatible endpoints + Anthropic
- Model/profile switching at runtime
- MCP server discovery/status UX in-app

## Documentation index

- [Architecture](docs/ARCHITECTURE.md)
- [Providers & modular adapter model](docs/PROVIDERS.md)
- [MCP usage](docs/MCP.md)
- [Example config](.zcode.example.json)

---

## Install

```bash
git clone https://github.com/Zellia-Keyboards/z-code.git
cd z-code
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

You can configure by env vars and/or `.zcode.json`.

### Environment variables

```bash
export ZCODE_PROVIDER="openai"      # openai | anthropic
export ZCODE_MODEL="gpt-4o"
export ZCODE_API_KEY="..."

# Optional OpenAI-compatible endpoint override
export ZCODE_BASE_URL="https://api.z.ai/api/coding/paas/v4"
```

### .zcode.json

Copy [.zcode.example.json](.zcode.example.json) and edit values.

Supports:

- base provider/model/key
- named `profiles`
- `mcpServers`

---

## Providers

z-code currently supports provider types:

- `openai` (used as **OpenAI-compatible** adapter)
- `anthropic`

Using `openai` + `baseURL` works for many vendors (Z.AI/GLM, DeepSeek, Groq, Together, Mistral, etc).

See full details in [docs/PROVIDERS.md](docs/PROVIDERS.md).

---

## MCP

Current MCP scope in z-code:

- Configurable `mcpServers` in `.zcode.json`
- `/mcp` command for visibility and toggling
- MCP status shown in UI

Protocol-level MCP tool execution is the next integration phase.

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
