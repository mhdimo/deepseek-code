# DeepSeek Code — Full Codebase Analysis

> **Version:** 0.1.0  
> **Runtime:** Bun + TypeScript + Ink (React TUI)  
> **Engine:** ai-sdk-cpp (native C++ agent loop)  
> **Provider:** DeepSeek (OpenAI-compatible API)

---

## Architecture Overview

DeepSeek Code is a **terminal-native AI coding agent** that runs entirely in the terminal. It uses a **native C++ engine** (`ai-sdk-cpp`) for the agentic loop (model calls, tool execution, memory management, context compaction), with a **TypeScript/React (Ink) TUI** for the user interface — connected via a Node.js native binding.

### High-Level Data Flow

```
User Input (TUI)
  │
  ▼
App.tsx ──► getOrCreateMemorySession() ──► C++ Session (owns history + memory)
  │                                              │
  │         query()                              ▼
  │         AsyncGenerator ◄── session.sendStream(userMessage)
  │                                              │
  │         processAgentStream()                 ▼
  │         consumes QueryEvents           C++ Agent Loop:
  │                                           1. Call model (DeepSeek API)
  │                                           2. Execute tools via async bridge
  │                                           3. Inject memory
  │                                           4. Auto-compact context
  │                                           5. Repeat until done
  │
  ▼
Ink TUI renders: messages, streaming text, tool blocks, status
```

---

## Directory Structure

```
deepseek-code/
├── src/
│   ├── index.tsx                 # Entry point — loads config, renders <App>
│   ├── Tool.ts                   # Core Tool interface, buildTool(), ToolDef
│   ├── tools.ts                  # Tool registry + ai-sdk-cpp binding adapter
│   ├── core/
│   │   └── types.ts              # Core types (duplicate of types/index.ts)
│   ├── types/
│   │   └── index.ts              # All shared TypeScript types
│   ├── components/               # Ink React components (TUI)
│   │   ├── App.tsx               # Main app — state, commands, streaming orchestration
│   │   ├── ChatPanel.tsx         # Message list + streaming output display
│   │   ├── MessageView.tsx       # Individual message renderer
│   │   ├── MessageResponse.tsx   # ⎿ border wrapper for assistant messages
│   │   ├── Markdown.tsx          # Rich markdown renderer (no deps)
│   │   ├── ToolBlock.tsx         # Tool execution display
│   │   ├── PermissionPrompt.tsx  # Permission approval UI
│   │   ├── TextInput.tsx         # Input wrapper with border
│   │   ├── MultilineTextInput.tsx# Multi-line input with cursor
│   │   ├── CommandPicker.tsx     # Slash command suggestions
│   │   ├── ShortcutOverlay.tsx   # Keyboard shortcuts panel
│   │   ├── QueuePreview.tsx      # Queued prompt display
│   │   ├── Spinner.tsx           # Blinking ⏺ loader
│   │   ├── WelcomeScreen.tsx     # Animated mascot welcome
│   │   └── index.ts             # Barrel exports
│   ├── services/
│   │   ├── query.ts              # Streaming query engine — drives C++ session
│   │   ├── agent/
│   │   │   ├── index.ts          # Agent configs (code/plan/review) + AgentManager
│   │   │   ├── base.ts           # Legacy Agent class (fallback, uses bindingStreamText)
│   │   │   └── agentSession.ts   # Memory-enabled C++ session management
│   │   ├── provider/
│   │   │   ├── index.ts          # Provider exports
│   │   │   └── registry.ts       # ai-sdk-cpp DeepSeek provider adapter
│   │   ├── tokenTracker.ts       # Token counting + cost estimation
│   │   ├── contextManager.ts     # JS-side context management (fallback)
│   │   └── tasks/
│   │       └── TaskStore.ts      # In-memory task store
│   ├── state/
│   │   └── storage.ts            # Persistent storage (~/.deepseek-code/)
│   ├── utils/
│   │   ├── config.ts             # Config loading (defaults ← file ← env ← CLI)
│   │   ├── toolUtils.ts          # Shared path resolution, diff preview, formatting
│   │   └── theme.ts              # DeepSeek-branded theme colors
│   └── tools/                    # 19 tool implementations (one dir each)
│       ├── FileReadTool/
│       ├── FileWriteTool/
│       ├── FileEditTool/
│       ├── BashTool/
│       ├── GlobTool/
│       ├── GrepTool/
│       ├── LS/
│       ├── WebFetchTool/
│       ├── WebSearchTool/
│       ├── NotebookEditTool/
│       ├── TodoWriteTool/
│       ├── TaskCreateTool/
│       ├── TaskGetTool/
│       ├── TaskUpdateTool/
│       ├── TaskListTool/
│       ├── AgentTool/
│       ├── AskUserQuestionTool/
│       ├── EnterPlanModeTool/
│       └── ExitPlanModeTool/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── AGENTS.md
│   ├── MCP.md
│   └── PROVIDERS.md
├── dist/                        # Built executable + native .node bindings
├── .deepseek-code.example.json  # Example config file
├── package.json
├── tsconfig.json
├── CLAUDE.md                    # Project context for AI agents
├── deepseek.md                  # Previous analysis (deprecated)
└── README.md
```

---

## Engine Architecture (Monumental: C++ Native Engine)

The most significant architectural decision in this codebase is the **port from Vercel AI SDK (TypeScript) to ai-sdk-cpp (native C++)**. This is a major migration that fundamentally changed the architecture.

### Before (Vercel AI SDK / TypeScript)
- `Agent` class in `base.ts` manually looped with `bindingStreamText()`
- `ContextManager` handled compaction in JS
- `TokenTracker` tracked usage in JS
- `query()` was a full agentic loop in TypeScript

### After (ai-sdk-cpp / Native C++)
- **C++ `Session`** owns conversation history, memory, and auto-compaction
- **MemoryContextStrategy** auto-injects relevant persisted memory each turn
- **SlidingWindowStrategy** auto-compacts near `maxContextTokens`
- The session is created once per (provider, model, workingDir, agent, memoryDir) and reused
- `resetMemorySession()` drops the cached session on `/clear` or provider switch
- Tool execution goes through the **async-tool bridge** (C++ calls JS via the binding, which permits interactive permissions)
- The `query()` module is now a **thin wrapper** that maps C++ native events → QueryEvent shape

### Critical Insights

1. **`src/services/agent/base.ts` (the Agent class) is a legacy fallback** — It uses `bindingStreamText()` directly rather than the Session. The `agentSession.ts` + `query.ts` path (via `agent.runStream` → wait, actually `query()` → `session.sendStream()`) is the modern path. But looking at `App.tsx`, it calls `getOrCreateMemorySession()` from `agentSession.ts` then passes the session to `query()`.

2. **The session is cached globally** — `let cache: CacheEntry | null = null` in `agentSession.ts`. This means the C++ Session persists across turns, maintaining history internally. The TypeScript `messages[]` state in `App.tsx` is a **display copy** — history is owned by the C++ side.

3. **Project context auto-injection** — When creating a session, `agentSession.ts` looks for `CLAUDE.md`, `DEEP.md`, or `AGENTS.md` in the working directory and appends them to the system prompt. This allows per-project context files.

4. **MCP tools are hooked up** — `mcpToolsetFromServer()` from the C++ binding connects to MCP servers and provides their tools as `extraToolSets` to the agent. This is wired in `agentSession.ts`.

5. **Dual type systems** — There are two nearly-identical type files: `src/core/types.ts` and `src/types/index.ts`. The `src/types/index.ts` has additional types (CostEstimate, TokenBudget, QueryEvent) not in `src/core/types.ts`. This is likely a merge artifact from the migration.

---

## Tool System

### Architecture

Each tool lives in its own directory under `src/tools/<ToolName>/` with:
- `<ToolName>.ts` — Implementation
- `prompt.ts` — Name constant and description string

Tools are defined using `buildTool()` from `Tool.ts`, which takes a `ToolDef` (partial) and fills in safe defaults:

```typescript
// Defaults provided by buildTool():
- isEnabled → true
- isConcurrencySafe → false
- isReadOnly → false
- checkPermissions → { approved: true } (allow by default)
- userFacingName → tool name
- maxResultSizeChars → 100_000
```

### Permission System

- **Read-only tools** (Read, Glob, Grep, LS, WebFetch, WebSearch): Auto-approved if agent allows read
- **Write tools** (Write, Edit): Request user permission with diff preview
- **Execute tools** (Bash): Request user permission with command preview
- **Metadata tools** (TodoWrite, TaskCreate/Get/Update/List): Always allowed, no prompt
- **Interactive tools** (AskUserQuestion, Agent, Enter/ExitPlanMode): Permission handled internally
- **Plan mode enforcement**: If `planMode` is true and tool is not read-only, execution is blocked with a message

The permission check flow in `toolsToBindingFormat()`:
1. Check if aborted
2. Check plan mode (block write/execute tools)
3. Call `tool.checkPermissions()` — may prompt user
4. If approved, call `tool.call()`
5. Wrap result as string, pass back to C++
6. Call `context.onToolResult()` for TUI updates

### All 19 Tools

| Tool | Category | ReadOnly | Perm Required | Description |
|------|----------|----------|---------------|-------------|
| **Read** | File | ✅ Yes | Read | Read file contents with line numbers |
| **Write** | File | No | ✅ Yes (diff) | Create/overwrite files with auto-mkdir |
| **Edit** | File | No | ✅ Yes (diff) | Exact string replacement, uniqueness check |
| **Bash** | Execute | No | ✅ Yes | `sh -c` with timeout, 50KB output cap |
| **Glob** | Search | ✅ Yes | Read | `find`-based, excludes node_modules/.git |
| **Grep** | Search | ✅ Yes | Read | `grep -rn`, excludes node_modules/.git/dist |
| **LS** | Search | ✅ Yes | Read | Directory listing with icons |
| **WebFetch** | Network | ✅ Yes | Network | Fetch URL, HTML→text, 50KB limit |
| **WebSearch** | Network | ✅ Yes | Network | DuckDuckGo HTML scraping, no API key needed |
| **NotebookEdit** | Jupyter | Depends | Write | Replace/insert/delete .ipynb cells |
| **TodoWrite** | Meta | No | No | Replace entire todo list |
| **TaskCreate** | Meta | No | No | Create task item |
| **TaskGet** | Meta | ✅ Yes | No | Get single task by ID |
| **TaskUpdate** | Meta | No | No | Update task fields (status "deleted" removes) |
| **TaskList** | Meta | ✅ Yes | No | List all tasks |
| **Agent** | Meta | Depends | — | Spawns sub-agent (explore/plan/code) |
| **AskUserQuestion** | Meta | ✅ Yes | — | Ask user with predefined options |
| **EnterPlanMode** | Meta | ✅ Yes | — | Toggle read-only mode |
| **ExitPlanMode** | Meta | ✅ Yes | — | Exit read-only mode |

---

## Multi-Agent System

Three built-in agents defined in `src/services/agent/index.ts`:

| Agent | Read | Write | Execute | Max Steps | Purpose |
|-------|------|-------|---------|-----------|---------|
| **Code** | ✅ | ✅ | ✅ | 50 | Full-access development |
| **Plan** | ✅ | ❌ | ❌ | 15 | Analysis & exploration |
| **Review** | ✅ | ❌ | ❌ | 15 | Code review & QA |

### AgentManager (singleton)
- `agentManager.createAgent(name, provider)` — creates legacy Agent instance
- `agentManager.getConfig(name)` — returns config for system prompt
- `agentManager.listAgents()` — returns all configs

Note: The modern flow uses `getOrCreateMemorySession()` which creates a C++ Agent directly, not the AgentManager.

---

## Configuration System

Config is merged with this priority (last wins):
1. **Defaults** (provider: deepseek, model: deepseek-chat, maxSteps: 25)
2. **Config file** (`.deepseek-code.json` in cwd, `~/.config/deepseek-code/config.json`, `~/.deepseek-code.json`, legacy `.zcode.*` paths)
3. **Environment variables** (`DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_PROVIDER`, `DEEPSEEK_MAX_STEPS`, `DEEPSEEK_AGENT`)
4. **Persisted settings** (`~/.deepseek-code/settings.json`)
5. **CLI arguments** (`--model`, `--api-key`, `--base-url`, `--agent`, `--max-steps`, `--resume`, etc.)

### Config file features:
- **`env:VAR_NAME`** references resolved at load time (for apiKey, profile keys, MCP env vars)
- **`profiles`**: Named model profiles, each with own provider/model/apiKey/baseURL
- **`mcpServers`**: MCP server definitions with command/args/env/cwd/enabled
- **`dangerouslySkipPermissions`**: Bypass permission prompts (not recommended)

### Persisted settings (at runtime):
- `/setup`, `/apikey`, `/model`, `/baseurl` commands save to `~/.deepseek-code/settings.json`
- Settings are merged on save (partial updates)

---

## Session & Persistence

### Settings (`~/.deepseek-code/settings.json`)
- `apiKey` (truncated on display), `model`, `baseURL`, `provider`, `defaultAgent`, `lastSessionHash`

### Sessions (`~/.deepseek-code/sessions/<hash>.json`)
- Auto-saved when `messages.length` changes
- Contains messages (role/content/timestamp/isError), tokenUsage, model, agent, workingDirectory
- Auto-pruned to keep 50 most recent
- Resume with `--resume <hash>` or `/resume <hash>`
- Session hash format: `<timestamp-base36>-<random4chars>`

---

## Provider System

Currently supports only **DeepSeek** via the `ai-sdk-cpp` native binding:

```typescript
createDeepSeekModel(config):
  const provider = createDeepSeek({ apiKey, baseUrl })
  return provider(modelId)
```

- Uses OpenAI-compatible endpoint: `https://api.deepseek.com/v1`
- Models: `deepseek-chat` (general), `deepseek-reasoner` (extended thinking)
- Pluggable via `registerProviderAdapter(type, adapter)`
- C++ binding handles auth, request formatting, and streaming

---

## Token Tracking & Cost

### TokenTracker (src/services/tokenTracker.ts)
- Accumulates per-step usage into session totals
- DeepSeek pricing model used for cost estimation:
  - `deepseek-chat`: $0.27/1M input, $1.10/1M output, $0.07/1M cache
  - `deepseek-reasoner`: $0.55/1M input, $2.19/1M output, $0.14/1M cache
- Assumes 70% cache hit rate for multi-turn conversations
- Display formatting: `formatTokenCount()` (1.2k, 1.5M), `formatCost()` (~$0.02)

### Cost Display in StatusBar
- Shown as `~$0.02` next to token count
- Also tracked in the QueryEvent `finish` event from the C++ engine

---

## MCP (Model Context Protocol) Support

### Current State: Partial
- **Config loaded**: MCP servers are defined in `.deepseek-code.json`
- **Wired to C++ engine**: `mcpToolsetFromServer()` connects to MCP servers and exposes their tools via `extraToolSets`
- **TUI controls**: `/mcp`, `/mcp enable <name>`, `/mcp disable <name>`
- **Status display**: Shows enabled/total MCP count in status bar and shortcuts

### MCP Server Config
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

---

## TUI Component Architecture (Ink/React)

All components in `src/components/`:

### App.tsx (Main — 1704 lines)
Central orchestrator managing:
- **State**: messages, input, streaming, agent, model, permissions, sessions, MCP, thinking mode, inspect mode
- **Keybindings**: Ctrl+C (exit), Ctrl+E (inspect mode), Ctrl+Q (clear queue), ? (shortcuts), Esc (interrupt/dismiss), Shift+Tab (whalethink), ↑↓ (history/picker), Tab/Enter (picker select)
- **Slash Commands**: /help, /setup, /model, /models, /apikey, /baseurl, /agent, /clear, /compact, /tools, /shortcuts, /mcp, /think, /queue, /sessions, /resume, /exit
- **Auto-detect API key**: If user types `sk-xxx` with no spaces, auto-configures
- **Queue system**: Prompts submitted during generation are queued and auto-drained
- **Input history**: Last 100 inputs, navigable with ↑↓
- **Permission callbacks**: Bridges Tool permission requests to PermissionPrompt UI

### Components Tree
```
<App>
  ├── <ChatPanel>
  │   ├── <WelcomeScreen>           (animated mascot, shown when no messages)
  │   ├── <Static items>
  │   │   └── <MessageView>
  │   │       ├── <MessageResponse>  (⎿ border)
  │   │       │   ├── <Markdown>     (rich markdown)
  │   │       │   └── <ToolBlock>    (tool execution display)
  │   │       └── ...
  │   └── Live streaming (when isLoading)
  │       ├── thinking (∴ dim italic)
  │       ├── <ToolBlock>[]         (streaming tool blocks)
  │       ├── <Markdown>            (streaming text)
  │       └── <Spinner>             (blinking ⏺ when thinking)
  ├── <PermissionPrompt>            (overlay when awaiting approval)
  ├── <ShortcutOverlay>             (shortcuts panel, toggle with ?)
  ├── <QueuePreview>                (queued prompts indicator)
  ├── <StatusBar>                   (model · agent · tokens · cost · file · modes)
  ├── <CommandPicker>               (slash command autocomplete)
  └── <TextInput>
      └── <MultilineTextInput>      (full editor with cursor)
```

### Markdown Rendering
Custom implementation (zero dependencies) in `Markdown.tsx`:
- **Inline**: bold (`**`), italic (`*`/`_`), code (`` ` ``), links (`[text](url)`)
- **Blocks**: headings (`#`-`######`), code fences (`` ``` ``), lists (ordered/unordered), blockquotes (`>`), horizontal rules (`---`)
- Optimized with special-char proximity lookup for fast plain-text scanning
- Memoized block parsing to avoid re-parsing on every render

### Inspection Mode (Ctrl+E)
- Navigates through all tool blocks across all messages
- Highlighted block shows ▶ indicator
- Space/Enter toggles expand/collapse of tool output
- Arrow keys navigate, Esc/q exits

### Thinking Modes
- **Off**: Normal generation
- **Whale**: `deepseek-reasoner` style extended thinking with teal glow ("🐋 WHALE" indicator)
- Toggle with `/think` or Shift+Tab

---

## Event System (Streaming)

### QueryEvent (from query.ts → App.tsx)
```
text-delta         — Streaming text chunk
thinking-delta     — Reasoning text chunk
tool-call-start    — Tool execution began
tool-call-delta    — Streaming tool arguments (JSON partials)
tool-call-end      — Tool arguments finalized
tool-call-result   — Tool execution completed
step-finish        — One agent step finished
token-usage        — Token count update
compact            — Context was compacted
finish             — Generation complete (cumulative usage + cost)
error              — Error occurred
```

### AgentEvent (legacy, from base.ts → App.tsx)
Similar structure but without `tool-call-delta`/`tool-call-end`/`token-usage`/`compact` event types.

### Stream Processing in App.tsx
- `processAgentStream()` iterates the AsyncGenerator
- `yieldToRenderer()` (setTimeout 0) between events for Ink painting
- Refs (`streamingTextRef`, `streamingThinkingRef`, `streamingToolUseRef`) hold mutable state
- On tool-call-result, the step is finalized into a Message in history
- Streaming state resets for the next agentic step

---

## Key Design Patterns

### 1. **C++ Owns History, JS Owns Display**
The native C++ Session maintains the authoritative conversation history with memory and auto-compaction. TypeScript `messages[]` state is a display copy. The session is cached globally and reused across turns.

### 2. **Async Tool Bridge**
C++ calls JS tool functions via the native binding. This is critical because permission prompts are interactive (require user input in the TUI). The bridge allows:
- C++ starts a tool call → calls into JS
- JS checks permissions → prompts user (async, may wait indefinitely)
- JS executes tool → returns result string
- C++ receives result → continues agent loop

### 3. **Permission Prompt with Feedback**
Users can Tab on Yes/No to add feedback text, which is embedded in the tool result as `💬 User note: ...`. The LLM sees this immediately, enabling interactive refinement.

### 4. **Session-Shared Mutable State**
The `ToolUseContext` holds mutable references for:
- `todos: TodoItem[]` — persists across turns within a session
- `tasks: TaskItem[]` — persists across turns
- `planMode: boolean` — persists across turns
These reset when the session is dropped (/clear or provider switch).

### 5. **Auto Context Compaction**
Two layers:
- **C++ side**: SlidingWindowStrategy auto-compacts near maxContextTokens
- **JS side**: ContextManager class for fallback (when using legacy Agent path)

### 6. **Error Categorization & Retry**
In `base.ts` (legacy Agent), errors are categorized and retried:
- **Auth** (401, 402): Not retryable
- **Rate limit** (429): Retryable with backoff
- **Server** (500, 503): Retryable
- **Network** (ECONNREFUSED, ENOTFOUND, ETIMEDOUT): Retryable
- **Timeout**: Not retryable

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `ai-sdk-cpp` | Native C++ AI SDK binding (local dependency) |
| `ink` ^6.8.0 | React for terminal — TUI framework |
| `react` ^19.2.4 | UI library |
| `chalk` ^5.6.2 | Terminal string styling |
| `chokidar` ^5.0.0 | File watching (unused in current code) |
| `ora` ^9.3.0 | Spinner (used in Spinner component) |
| `zod` ^4.3.6 | Schema validation for tool inputs |
| `zod-to-json-schema` ^3.25.2 | JSON Schema conversion for API (unused in new path) |

---

## Build & Development

```bash
bun run dev          # bun run src/index.tsx
bun run build        # bun build src/index.tsx → ./dist/index.js + native .node files
bun run typecheck    # tsc --noEmit
```

The build output is a standalone JavaScript file at `./dist/index.js` plus the native C++ `.node` binding files for various architectures.

---

## CLI Usage

```bash
deepseek-code                          # Run with defaults
deepseek-code --model deepseek-reasoner # Use reasoning model
deepseek-code -k sk-xxxxx              # Set API key
deepseek-code -r <hash>                # Resume session
deepseek-code --dangerously-skip-permissions  # Auto-approve all tools
```

---

## Observations & Potential Issues

1. **Duplicate type files**: `src/core/types.ts` and `src/types/index.ts` — nearly identical but not in sync. `src/types/index.ts` is the more complete one (used by imports). `src/core/types.ts` appears to be stale.

2. **Legacy code**: `src/services/agent/base.ts` (Agent class) is mostly unused in the modern flow — the C++ Session path goes through `agentSession.ts` + `query.ts`. The Agent class is still maintained as a fallback.

3. **ContextManager in JS is technically dead code** — Compaction is handled by C++ SlidingWindowStrategy. The JS ContextManager is only relevant if the legacy Agent path is used.

4. **TokenTracker in JS may be partially redundant** — The C++ finish event carries cumulative usage, but the JS TokenTracker maintains its own accumulation for display purposes.

5. **No test framework** — The project has no test configuration. `bun test` will fail.

6. **Chokidar dependency** — Imported in package.json but not used anywhere in the source code. Likely leftover from an earlier version.

7. **Ora dependency** — Imported in package.json but the Spinner component implements its own blinking mechanism without ora.

8. **Constants directory** — Exists in the directory structure (`src/constants/`) but has no files. Likely planned but not implemented.

9. **Module resolution uses `.js` extensions** even though the source files are `.ts`/`.tsx`. This is standard for TypeScript ESM with `verbatimModuleSyntax`.

10. **The `this.model = provider(modelId)` pattern** — `createDeepSeek` returns a provider instance that is itself a callable function to create model instances. This is the C++ binding's pattern.

11. **`todoWriteTool` and task tools manage state via ToolUseContext** — The state lives in closures within the session context (`todos`, `tasks` arrays). This is simpler than a separate store but means state is lost on session reset.

12. **WebSearchTool scrapes DuckDuckGo HTML** — No official API key needed, but scrapes HTML which is fragile and may break if DuckDuckGo changes their markup.

13. **Inspect mode selects last tool block by default** — When entering inspect mode via Ctrl+E, the last tool block is auto-selected (not the first). This is a design choice to see the most recent tool result first.

14. **The `resumeSessionHash` parameter** — Passed from CLI but the `/resume` command also works for in-session resume. The CLI resume happens in a `useEffect` on mount.
