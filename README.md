# z-code

Terminal-native AI coding agent inspired by Claude Code and OpenCode.

## Features

- **TUI Interface** - Beautiful terminal UI with panel navigation
- **Multi-Provider Support** - Works with OpenAI and Claude APIs
- **Agent System** - Switch between "build" (full access) and "plan" (read-only) agents
- **File Tree** - Browse your codebase from the terminal
- **Tool System** - Built-in tools for reading, editing, and executing commands

## Installation

```bash
# Clone the repository
git clone https://github.com/your-username/z-code.git
cd z-code

# Install dependencies
bun install

# Or with npm
npm install
```

## Configuration

Set your API key as an environment variable:

```bash
# For OpenAI
export ZCODE_API_KEY="your-openai-api-key"
export ZCODE_PROVIDER="openai"

# For Claude
export ZCODE_API_KEY="your-anthropic-api-key"
export ZCODE_PROVIDER="claude"

# Optional: custom base URL (for compatible APIs)
export ZCODE_BASE_URL="https://your-api-endpoint.com"
export ZCODE_MODEL="your-model-name"
```

## Usage

```bash
# Run z-code
bun run dev
```

### Keybindings

| Key | Action |
|-----|--------|
| `Tab` | Switch between panels |
| `Ctrl+C` | Exit |
| `/agent` | Switch between build/plan agents |

## Architecture

```
z-code/
├── src/
│   ├── agent/       # Agent system (build, plan)
│   ├── core/        # Core types and interfaces
│   ├── provider/    # AI provider abstraction (OpenAI, Claude)
│   ├── tool/        # Tool system (read, edit, bash)
│   ├── tui/         # Terminal UI components (Ink)
│   └── index.tsx    # Entry point
```

### Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **UI Framework**: Ink (React for CLIs)
- **AI SDK**: Vercel AI SDK (provider-agnostic)

## Development

```bash
# Run in development mode
bun run dev

# Type checking
bun run typecheck

# Build for production
bun run build
```

## License

MIT
