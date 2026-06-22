# DeepSeek Code - Project Overview

## Project Summary
DeepSeek Code is a terminal-native AI coding agent powered by DeepSeek's API, built with Bun + Ink (React TUI) + Vercel AI SDK. It provides an interactive coding assistant with built-in tools for file operations, shell commands, and code analysis.

## Key Technologies
- **Runtime**: Bun (JavaScript/TypeScript runtime)
- **UI Framework**: Ink (React for terminal applications)
- **AI Integration**: Vercel AI SDK with DeepSeek API
- **Language**: TypeScript
- **Package Manager**: Bun

## Project Structure
```
deepseek-code/
├── src/
│   ├── index.tsx              # Main entry point
│   ├── Tool.ts                # Core Tool interface
│   ├── tools.ts               # Tool registry
│   ├── components/            # Ink React components
│   ├── services/              # Core services (query, agent, token tracking, etc.)
│   ├── tools/                 # Individual tool implementations
│   ├── types/                 # TypeScript type definitions
│   ├── utils/                 # Utility functions
│   ├── state/                 # State management and persistence
│   └── constants/             # Constants and configuration
├── dist/                      # Built executable output
├── docs/                      # Documentation
├── package.json              # Dependencies and scripts
├── tsconfig.json            # TypeScript configuration
└── bun.lock                  # Bun lock file
```

## Available Tools
The system includes the following built-in tools:
- **File Operations**: Read, Write, Edit
- **Shell Commands**: Bash
- **File Search**: Glob, Grep, LS
- **Web Operations**: WebFetch, WebSearch
- **Notebook Editing**: NotebookEdit
- **Task Management**: TodoWrite, TaskCreate, TaskGet, TaskUpdate, TaskList
- **Agent Control**: Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode

## Agent System
Three specialized agents are available:
1. **Code Agent**: Full access (read + write + execute), 25 max steps
2. **Plan Agent**: Read-only, 15 max steps - for analysis and planning
3. **Review Agent**: Read-only, 15 max steps - for code review

## Configuration
Configuration is loaded with the following priority (highest to lowest):
1. CLI arguments
2. Persisted settings
3. Environment variables
4. `.deepseek-code.json` file
5. Default values

### Environment Variables
- `DEEPSEEK_API_KEY`: DeepSeek API key
- `DEEPSEEK_MODEL`: Model ID (`deepseek-chat` or `deepseek-reasoner`)
- `DEEPSEEK_BASE_URL`: Optional endpoint override

### Configuration File
Example config file: `.deepseek-code.example.json`
Supports:
- Base model and API key
- Named profiles
- MCP server configuration

## Available Models
- `deepseek-chat`: General-purpose coding assistant (default)
- `deepseek-reasoner`: Advanced reasoning with extended thinking

## Development Commands
```bash
bun run dev          # Run in development mode
bun run build        # Build executable to ./dist/index.js
bun run typecheck    # TypeScript type check (no emit)
```

## Key Architecture Components

### 1. Query Engine (`src/services/query.ts`)
- Main entry point for AI interactions
- AsyncGenerator-based agentic loop
- Handles streaming, retries, and error recovery
- Integrates with token tracking and context management

### 2. Tool System (`src/Tool.ts`, `src/tools.ts`)
- Each tool has its own directory under `src/tools/`
- Uses Zod schemas for parameter validation
- Permission system for write/execute operations
- Converts tools to AI SDK format for API compatibility

### 3. Token Tracking (`src/services/tokenTracker.ts`)
- Accumulates token usage across steps
- Estimates cost using DeepSeek pricing
- Displayed in the StatusBar component

### 4. Context Management (`src/services/contextManager.ts`)
- Estimates token usage (1 token ≈ 4 characters)
- Auto-compacts when approaching context limits
- Truncates tool outputs to save tokens

### 5. Permission System
- Write/Edit/Bash operations require user approval
- Permission prompt shows diff previews
- User feedback is embedded in tool results
- Wait time is subtracted from reported tool duration

## UI Components
- **App.tsx**: Main application state management
- **ChatPanel.tsx**: Message rendering and streaming display
- **MessageView.tsx**: Individual message rendering with Markdown
- **ToolBlock.tsx**: Tool execution display with colors and duration
- **StatusBar.tsx**: Model, cost, and token display
- **PermissionPrompt.tsx**: Permission approval UI with diff preview
- **CommandPicker.tsx**: Slash command suggestions

## MCP (Model Context Protocol) Support
- Configurable MCP servers in `.deepseek-code.json`
- `/mcp` command for visibility and toggling
- MCP status shown in UI

## In-App Commands
- `/help`: Show help information
- `/setup`: Configuration setup
- `/model`, `/models`: Model selection
- `/apikey`: API key management
- `/agent`: Agent selection
- `/think`: Toggle thinking mode
- `/mcp`: MCP server management
- `/shortcuts`: Show keyboard shortcuts

## Development Notes
- Uses AI SDK v6 with DeepSeek's OpenAI-compatible endpoint
- Type inference issues between Zod v4 and AI SDK v6 are handled with explicit typing
- Streaming updates are rendered with `yieldToRenderer()` to allow Ink to paint between events
- Session and settings are persisted in `~/.deepseek-code/`

## Testing
No test framework is currently configured. The `bun test` command will work once tests are added.

## License
MIT License