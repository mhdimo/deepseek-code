# DeepSeek Code Agents

## Overview

DeepSeek Code features a multi-agent system with specialized agents for different coding tasks. Each agent has distinct permissions, system prompts, and capabilities tailored to specific workflows.

## Available Agents

### 1. **Code Agent** (`code`)
**Full-access development agent**

- **Permissions**: Read, Write, Execute
- **Max Steps**: 25
- **Temperature**: 0
- **Description**: Full-access agent for development — reads, writes, executes

**Use Cases**:
- Implementing features and bug fixes
- Running tests and builds
- Creating new files and directories
- Modifying existing code
- Executing shell commands

**System Prompt**:
```
You are DeepSeek Code, an expert AI coding agent running in the user's terminal.

You have access to the following tools:
- Read: Read file contents
- Write: Create or overwrite files
- Edit: Edit files by replacing exact strings
- Bash: Execute shell commands
- Glob: Find files by pattern
- Grep: Search for text in files
- LS: List directory contents

Guidelines:
- Read files before editing them to understand the full context
- Use Grep and Glob to explore the codebase efficiently
- Make minimal, precise edits — don't rewrite entire files unnecessarily
- Run tests and type checks after making changes
- If a task is complex, break it into steps and explain your plan
- Be direct and concise. Show code context when relevant.
- When editing, include enough surrounding context in old_string to match uniquely
- If you encounter an error, analyze it and try to fix it
- Prefer using Edit over Write for existing files
```

### 2. **Plan Agent** (`plan`)
**Read-only analysis and planning agent**

- **Permissions**: Read only
- **Max Steps**: 15
- **Temperature**: 0
- **Description**: Read-only agent for analysis, exploration, and planning

**Use Cases**:
- Understanding codebase architecture
- Planning changes before implementation
- Analyzing problems and suggesting solutions
- Reviewing architecture and suggesting improvements
- Finding relevant code across the codebase

**System Prompt**:
```
You are DeepSeek Code's planning agent. You explore and analyze codebases.

You have access to read-only tools:
- Read: Read file contents
- Glob: Find files by pattern
- Grep: Search for text in files
- LS: List directory contents

You do NOT have write or execute access. Your role is to:
- Understand and explain how code works
- Plan changes before implementation
- Analyze problems and suggest solutions
- Review architecture and suggest improvements
- Find relevant code across the codebase

When planning changes, be specific about which files need editing and what the changes should look like. The user can then switch to the Code agent to implement.
```

### 3. **Review Agent** (`review`)
**Code review agent**

- **Permissions**: Read only
- **Max Steps**: 15
- **Temperature**: 0
- **Description**: Code review agent — reads code and provides detailed feedback

**Use Cases**:
- Code reviews and quality assessment
- Security vulnerability scanning
- Performance analysis
- Code style and best practices review
- Error handling completeness checks

**System Prompt**:
```
You are DeepSeek Code's code review agent. You provide thorough code reviews.

You have access to read-only tools:
- Read: Read file contents
- Glob: Find files by pattern
- Grep: Search for text in files
- LS: List directory contents

Review guidelines:
- Check for bugs, logic errors, and edge cases
- Evaluate code style, naming, and organization
- Look for security issues (SQL injection, XSS, path traversal, etc.)
- Check error handling completeness
- Identify performance concerns
- Suggest improvements with concrete code examples
- Be constructive — explain WHY something should change
- Rate severity: 🔴 Critical, 🟡 Warning, 🔵 Suggestion
```

## Agent Permissions

Each agent has a permission ruleset that controls access to tools:

```typescript
interface PermissionRuleset {
  allowRead: boolean;    // Read, Glob, Grep, LS tools
  allowWrite: boolean;   // Write, Edit tools
  allowExecute: boolean; // Bash tool
  allowNetwork: boolean; // Network access (currently unused)
}
```

### Permission Matrix

| Agent | Read | Write | Execute | Network |
|-------|------|-------|---------|---------|
| Code | ✅ | ✅ | ✅ | ❌ |
| Plan | ✅ | ❌ | ❌ | ❌ |
| Review | ✅ | ❌ | ❌ | ❌ |

## Agent Configuration

Agents are defined in `src/agent/index.ts` with the following structure:

```typescript
interface AgentConfig {
  name: AgentName;           // "code", "plan", "review"
  displayName: string;       // "Code", "Plan", "Review"
  description: string;       // Human-readable description
  systemPrompt: string;      // System prompt for the agent
  temperature?: number;      // Model temperature (0 for deterministic)
  maxTokens?: number;        // Max tokens per step (16384)
  maxSteps?: number;        // Max tool-calling steps (25 for code, 15 for others)
  permissions: PermissionRuleset; // Tool access permissions
}
```

## Using Agents

### In-App Commands

- `/agent <name>` - Switch to a different agent
- `/agents` - List available agents with descriptions

### Switching Agents

```bash
# Switch to Plan agent for analysis
/agent plan

# Switch to Code agent for implementation
/agent code

# Switch to Review agent for code review
/agent review
```

### Agent Workflow Example

1. **Analysis Phase** (Plan Agent):
   ```
   /agent plan
   Analyze the authentication system and suggest improvements
   ```

2. **Implementation Phase** (Code Agent):
   ```
   /agent code
   Implement the suggested authentication improvements
   ```

3. **Review Phase** (Review Agent):
   ```
   /agent review
   Review the authentication implementation for security issues
   ```

## Agent Manager

The `AgentManager` class in `src/agent/index.ts` provides:

```typescript
class AgentManager {
  createAgent(name: AgentName, provider: ProviderConfig): Agent
  getConfig(name: AgentName): AgentConfig
  listAgents(): AgentConfig[]
}
```

### Creating Custom Agents

To add a new agent:

1. Add the agent name to `AgentName` type in `src/core/types.ts`:
   ```typescript
   export type AgentName = "code" | "plan" | "review" | "your-agent";
   ```

2. Add agent configuration in `src/agent/index.ts`:
   ```typescript
   const AGENTS: Record<AgentName, AgentConfig> = {
     // ... existing agents
     "your-agent": {
       name: "your-agent",
       displayName: "Your Agent",
       description: "Description of your agent",
       systemPrompt: "Your system prompt",
       temperature: 0,
       maxTokens: 16384,
       maxSteps: 20,
       permissions: {
         allowRead: true,
         allowWrite: false,
         allowExecute: false,
         allowNetwork: false,
       },
     },
   };
   ```

## Agent Execution Flow

1. **User Input**: User submits a prompt via the TUI
2. **Agent Creation**: `AgentManager.createAgent()` creates an agent instance
3. **Tool Setup**: Tools are created based on agent permissions
4. **Streaming Loop**: Agent runs in a multi-step loop:
   - Call `streamText()` with available tools
   - Stream text and tool events to TUI
   - Execute tool calls if requested
   - Add tool results to message history
   - Repeat until no tool calls or max steps reached
5. **Event Processing**: TUI processes agent events and updates display

### Multi-Step Tool Calling

Agents use a manual multi-step loop for tool calling:

```typescript
for (let step = 0; step < maxSteps; step++) {
  // 1. Call streamText with tools
  const result = await streamText(streamOptions);
  
  // 2. Stream events to TUI
  for await (const event of result.fullStream) {
    // Process text-delta, tool-call, tool-result events
  }
  
  // 3. If tool calls were made, add to message history
  // 4. Loop continues with updated message history
}
```

## Available Tools

All agents have access to tools based on their permissions:

### Read Tools (available to all agents)
- **Read**: Read file contents with line numbers
- **Glob**: Find files by pattern (excludes node_modules, .git)
- **Grep**: Search for text in files with regex
- **LS**: List directory contents with file type icons

### Write Tools (Code agent only)
- **Write**: Create or overwrite files (with permission prompt)
- **Edit**: Edit files by replacing exact strings (with permission prompt)

### Execute Tools (Code agent only)
- **Bash**: Execute shell commands (with permission prompt, 120s timeout)

## Permission System

### User Permission Prompts

For tools requiring user approval (Write, Edit, Bash):
1. Agent requests permission with tool name and description
2. TUI shows permission prompt with tool details
3. User approves or denies the action
4. Tool execution proceeds or is cancelled

### Skipping Permissions

Set `dangerouslySkipPermissions: true` in config to bypass permission prompts (not recommended).

## Best Practices

### When to Use Each Agent

1. **Code Agent**: When you need to make changes, run commands, or implement features
2. **Plan Agent**: When exploring a new codebase, planning architecture, or analyzing problems
3. **Review Agent**: When reviewing code for quality, security, or best practices

### Agent Switching Strategy

- Start with **Plan Agent** to understand the problem
- Switch to **Code Agent** to implement solutions
- Use **Review Agent** to validate the implementation

### Tool Usage Guidelines

1. **Read before writing**: Always read files before editing them
2. **Use Grep/Glob for exploration**: Find relevant code efficiently
3. **Minimal edits**: Make precise changes rather than rewriting files
4. **Test changes**: Run tests and type checks after modifications
5. **Explain plans**: For complex tasks, break down steps and explain your approach

## Configuration

### Default Agent

Set the default agent in `.deepseek-code.json`:

```json
{
  "defaultAgent": "code"
}
```

### Agent-Specific Settings

While agents have fixed permissions and prompts, you can customize:
- `maxSteps` in config file (applies to all agents)
- Model selection via `/model` command
- Temperature via provider configuration

## Troubleshooting

### Agent Not Responding
- Check if agent reached `maxSteps` limit
- Verify API key is configured
- Check for permission prompts awaiting approval

### Tool Permission Denied
- Verify you're using the correct agent (e.g., Code agent for write operations)
- Check agent permissions in the agent configuration

### High Token Usage
- Use Plan agent for exploration to avoid unnecessary tool calls
- Set lower `maxSteps` for complex agents
- Consider breaking tasks into smaller prompts

## Future Enhancements

Planned agent system improvements:
- Custom agent definitions via config file
- Agent-specific temperature and model settings
- Inter-agent communication (handoff between agents)
- MCP tool integration for all agents
- Agent collaboration workflows