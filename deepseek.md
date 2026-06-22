# DeepSeek Code - Project Analysis

## Overview
DeepSeek Code is a **terminal-native AI coding agent** powered by DeepSeek's API. It provides an interactive coding assistant with built-in tools for file operations, shell commands, and code analysis, all running directly in your terminal with a React-based TUI (Text User Interface).

## Core Features

### 1. **Multi-Agent System**
The project features three specialized agents for different coding workflows:
- **Code Agent**: Full access (read/write/execute) for implementation (25 max steps)
- **Plan Agent**: Read-only for analysis and planning (15 max steps)
- **Review Agent**: Read-only for code review and security analysis (15 max steps)

### 2. **Built-in Tools**
The system includes a comprehensive set of tools:
- **File Operations**: Read, Write, Edit files
- **Shell Commands**: Execute Bash commands
- **File Search**: Glob, Grep, LS for exploring codebases
- **Web Operations**: WebFetch, WebSearch
- **Notebook Editing**: Jupyter notebook support
- **Task Management**: Todo lists and task tracking
- **Agent Control**: Sub-agent delegation and user interaction

### 3. **Terminal User Interface (TUI)**
Built with **Ink** (React for terminal apps), featuring:
- Real-time streaming responses
- Interactive command picker (`/` prefix commands)
- Permission prompts for write/execute operations
- Status bar with model info, token usage, and cost estimation
- Rich Markdown rendering for code and documentation

### 4. **DeepSeek API Integration**
- Supports both `deepseek-chat` (general purpose) and `deepseek-reasoner` (advanced reasoning)
- Uses Vercel AI SDK for model interaction
- OpenAI-compatible endpoint at `https://api.deepseek.com/v1`

## Technical Architecture

### **Runtime & Stack**
- **Runtime**: Bun (JavaScript/TypeScript)
- **Language**: TypeScript
- **UI Framework**: Ink (React for terminal)
- **AI Integration**: Vercel AI SDK v6
- **Package Manager**: Bun

### **Key Components**
1. **Query Engine** (`src/services/query.ts`): AsyncGenerator-based agentic loop with streaming, retries, and error recovery
2. **Tool System** (`src/Tool.ts`, `src/tools.ts`): Zod-based tool definitions with permission system
3. **Token Tracking** (`src/services/tokenTracker.ts`): Real-time token counting and cost estimation
4. **Context Management** (`src/services/contextManager.ts`): Auto-compaction when approaching context limits
5. **Permission System**: User approval required for write/edit/execute operations with diff previews

### **Configuration System**
Configuration is loaded with priority (highest to lowest):
1. CLI arguments
2. Persisted settings (`~/.deepseek-code/`)
3. Environment variables (`DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, etc.)
4. `.deepseek-code.json` config file
5. Default values

## How It Works

### **Execution Flow**
1. User submits a prompt via the TUI
2. System creates an agent instance based on current agent selection
3. Query engine runs a multi-step loop:
   - Calls DeepSeek API with available tools
   - Streams responses to TUI in real-time
   - Executes tool calls when requested
   - Adds tool results to message history
   - Repeats until no tool calls or max steps reached
4. User can approve/deny permission requests for write/execute operations

### **Tool Calling Process**
- Each tool has Zod schemas for parameter validation
- Tools are converted to JSON Schema format for DeepSeek API compatibility
- Permission checks happen at execution time
- Tool results are embedded in the conversation history for context

## MCP (Model Context Protocol) Support

### **Current State**
- **Configuration**: MCP servers can be defined in `.deepseek-code.json`
- **UX**: `/mcp` command for visibility and toggling, status shown in UI
- **Limitation**: Protocol-level MCP tool execution is planned but not fully implemented yet

### **Example MCP Configuration**
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true
    }
  }
}
```

## Development Commands

```bash
bun run dev          # Run in development mode
bun run build        # Build executable to ./dist/index.js
bun run typecheck    # TypeScript type check
```

## Project Structure

```
deepseek-code/
├── src/
│   ├── index.tsx              # Main entry point
│   ├── Tool.ts                # Core Tool interface
│   ├── tools.ts               # Tool registry
│   ├── components/            # Ink React components (App, ChatPanel, etc.)
│   ├── services/              # Core services (query, agent, token tracking)
│   ├── tools/                 # Individual tool implementations
│   ├── types/                 # TypeScript type definitions
│   ├── utils/                 # Utility functions
│   ├── state/                 # State management and persistence
│   └── constants/             # Constants and configuration
├── dist/                      # Built executable output
├── docs/                      # Documentation
└── package.json              # Dependencies and scripts
```

## Use Cases

### **Development Workflow**
1. **Analysis**: Use Plan agent to explore codebase and understand architecture
2. **Implementation**: Switch to Code agent to make changes and run commands
3. **Review**: Use Review agent to check for bugs, security issues, and best practices

### **Common Tasks**
- Reading and understanding existing code
- Implementing new features
- Debugging and fixing issues
- Running tests and builds
- Exploring unfamiliar codebases
- Code review and quality assessment

## Key Design Decisions

### **1. Terminal-First Approach**
- No web interface or external dependencies
- Works entirely within the terminal
- Leverages existing terminal workflows

### **2. Permission System**
- Write/Edit/Bash operations require explicit user approval
- Shows diff previews before making changes
- User feedback is embedded in tool results for the AI

### **3. Multi-Step Agentic Loop**
- Agents can make multiple tool calls in sequence
- Context is maintained between steps
- Auto-compaction prevents context window overflow

### **4. Real-time Streaming**
- Responses stream character-by-character
- Tool execution results appear as they happen
- Status updates show token usage and costs

## Limitations & Future Directions

### **Current Limitations**
- MCP tool execution not fully implemented
- Limited to DeepSeek API (though architecture supports other providers)
- No test framework configured yet

### **Planned Enhancements**
- Full MCP protocol integration
- Support for additional AI providers
- Custom agent definitions via config
- Inter-agent communication and handoff
- Enhanced collaboration workflows

## Getting Started

1. **Installation**: `bun install`
2. **Configuration**: Set `DEEPSEEK_API_KEY` environment variable or create `.deepseek-code.json`
3. **Run**: `bun run dev`
4. **Use**: Type prompts, use `/` commands for agent switching and configuration

## Why This Project Matters

DeepSeek Code represents a **terminal-native approach to AI-assisted coding**, bringing powerful AI capabilities directly into developers' existing workflows without requiring web interfaces or complex setups. Its multi-agent system allows for specialized workflows, while the permission system ensures safety when making changes to codebases.

The project demonstrates how modern AI can be integrated into traditional development environments, providing assistance while maintaining developer control and understanding of the changes being made.