# Claude-Style UI and Slash-Command Parity Design

**Date:** 2026-08-14  
**Status:** Approved for implementation  
**Source references:** `/Users/liang/Downloads/claude-code-main/src/` and `/Users/liang/ai-sdk-cpp/`

## Goal

Bring DeepSeek Code’s interactive terminal experience in line with the supplied Claude Code source for the feature surface this application can support, while preserving the existing ai-sdk-cpp native agent/session engine, tools, permissions, and DeepSeek provider configuration.

Parity means matching the observable terminal behavior and visual hierarchy—not copying Claude Code’s Anthropic-specific runtime, private services, or unavailable product features.

## Scope

### In scope

- Stable Ink redraw behavior during typing, streaming, resizing, picker navigation, and overlays.
- Claude-style prompt composition: prompt indicator, input border/footer placement, command suggestions, width-aware truncation, selection styling, and compact status hints.
- Claude-style message composition for user prompts, assistant text, thinking blocks, tool activity, errors, and system/local command output.
- A canonical slash-command registry shared by autocomplete, help, aliases, parsing, and dispatch lookup.
- Correct argument parsing and alias handling, including `/setup <api-key> [model]`.
- Existing local commands that this application can execute over its current tools and state, including model, session, project, diagnostics, skills, plugin, MCP, queue, export, search, review, and settings commands.
- Custom command and installed plugin command merging with deterministic deduplication.
- Pure Bun tests for command behavior and layout/formatting helpers.

### Out of scope

- Replacing the native ai-sdk-cpp `Agent`, `Session`, `sendStream`, compaction, or tool-loop implementation.
- Anthropic OAuth, billing, remote sessions, teams, voice, browser integrations, Claude Desktop integrations, or other Claude-only services.
- Reimplementing Claude Code’s private Ink fork or importing its provider-specific dependency graph.
- Adding commands that cannot perform a meaningful local action. Unsupported Claude commands will not be advertised as available.
- A broad unrelated refactor of the 4,000-line `App.tsx`; extraction is limited to command metadata/parsing and focused UI helpers needed for parity.

## Design

### 1. Native engine boundary

The existing flow remains authoritative:

```text
App submit
  -> getOrCreateMemorySession()
  -> ai-sdk-cpp Session.sendStream()
  -> services/query.ts event mapping
  -> App streaming refs/state
  -> ChatPanel/message rows
```

UI work may change how `QueryEvent` values are stored or rendered, but it must not recreate the agent loop in TypeScript, manually compact history, or replace `Session.sendStream()` with a different provider SDK. The session cache, native compaction, native tool execution, and `ai-sdk-cpp` dependency remain in place.

The existing stream event types are sufficient for the parity layer:

- `text-delta` renders assistant text.
- `thinking-start`, `thinking-delta`, and `thinking-end` render collapsed or expanded reasoning.
- `tool-call-start`, `tool-call-delta`, `tool-call-end`, and `tool-call-result` render tool rows and output.
- `finish`, `token-usage`, `compact`, and `error` update status and system output.

### 2. Canonical command registry

Create a pure command registry module under `src/services/commands/` with one definition per supported command. A definition contains:

- canonical name without the leading slash;
- aliases;
- description and argument hint;
- help group/category;
- whether the command accepts arguments;
- an execution key used by `App.tsx` dispatch.

The registry exposes pure functions for:

- normalizing a command token and resolving aliases;
- parsing a full slash input into `{ name, args, rawArgs }`;
- filtering and ranking suggestions for a partial `/...` input;
- merging built-ins, custom commands, and plugin commands with canonical-name deduplication;
- producing help groups and picker definitions from the same source.

`App.tsx` remains responsible for stateful command effects in the first pass. It will resolve the parsed command through the registry, then route to the existing handler switch or custom/plugin execution path. This keeps the change safe while eliminating metadata and parsing drift.

The supported built-in registry will cover the commands already backed by this application: `/help`, `/shortcuts`, `/setup`, `/model`, `/models`, `/apikey`, `/baseurl`, `/agent`, `/plan`, `/review`, `/security-review`, `/think`, `/effort`, `/skills`, `/tools`, `/hooks`, `/init`, `/memory`, `/permissions`, `/workspace`, `/branch`, `/env`, `/sessions`, `/resume`, `/history`, `/messages`, `/rewind`, `/search`, `/export`, `/compact`, `/copy`, `/clear`, `/commit`, `/pr`, `/diff`, `/doctor`, `/cost`, `/usage`, `/stats`, `/mcp`, `/queue`, `/statusline`, `/settings`, `/config`, `/status`, `/theme`, `/output-style`, `/context`, `/todos`, `/bashes`, `/plugin`, `/plugins`, `/exit`, and `/quit`.

The registry will not advertise commands that have no supported implementation.

### 3. Prompt and picker rendering

The prompt area will follow the supplied Claude layout as an independent bottom composition:

```text
<optional queue/tasks/mention/suggestion rows>
── cwd ─────────────────────────────────────────────
❯ <multiline input with visible cursor>
────────────────────────────────────────────────────
<status bar / contextual hints>
```

The picker will:

- show only while the input is a partial slash command with no whitespace/newline;
- show at most six inline rows, centered around the selected item;
- keep the command column at a stable width relative to terminal width;
- truncate descriptions to one line rather than causing layout growth;
- use the theme accent for the selected command and dim unselected rows;
- make Enter/Tab selection behavior consistent with Claude-style typeahead: commands with arguments insert the usage hint, argumentless commands execute immediately;
- prevent the prompt from submitting while a non-file suggestion list is active;
- preserve existing ↑/↓ history behavior when the picker is not active.

Custom and plugin commands use the same row format and ranking rules as built-ins.

### 4. Conversation rendering

The transcript will preserve chronological message blocks and use consistent visual roles:

- User messages begin with the `❯` prompt marker and wrap within the available width.
- Assistant text uses the Claude-style dot marker and the existing Markdown renderer.
- Thinking is collapsed by default to a dim italic `∴ Thinking/Thought` row with a short preview; transcript mode expands the full content.
- Tool calls use a compact status marker, bold tool name, concise argument preview, duration, and expandable output/diff content.
- Errors and system/local command output use the existing response/error styling rather than looking like ordinary assistant text.
- Streaming blocks render in the same row format as finalized blocks so the layout does not jump when a turn completes.

The implementation will keep the current inspect mode, transcript mode, queue preview, permission prompt, task list, file mentions, settings overlays, and plugin overlay compatible with the new bottom composition.

### 5. Ink rendering stability

The root renderer will use full redraw mode (`incrementalRendering: false`) because the current incremental mode can leave cursor/input state desynchronized during streaming and overlays. Resize handling will remain debounced. Components that render dynamic terminal-width separators will use the current stdout dimensions and avoid writing directly to stdout during normal rendering.

### 6. Error and interruption behavior

- A malformed slash command produces one local system message with usage guidance and never reaches the model.
- Unknown commands remain local and list `/help` as the recovery path.
- Commands entered while a turn is running preserve the existing queue/interruption rules.
- Escape and Ctrl+C behavior remain unchanged except for picker/overlay priority matching the new prompt composition.
- Native stream errors continue through `services/recovery.ts`; the UI only changes their presentation.
- Custom/plugin command failures are reported as local system output and do not corrupt the native session.

## Testing strategy

Tests will be written before implementation for each pure behavior:

1. command parser accepts canonical names, aliases, quoted/space-containing arguments, and `/setup <key> [model]`;
2. suggestion filtering ranks exact/prefix/alias matches and caps visible output deterministically;
3. built-in, custom, and plugin commands merge without duplicate canonical names;
4. help groups and picker definitions are generated from the same registry;
5. layout helpers calculate safe prompt/picker widths and single-line truncation for narrow terminals;
6. existing typecheck and build continue to pass.

The implementation will use Bun’s test runner. Verification will include `bun test`, `bun run typecheck`, `bun run build`, and a headless/native binding smoke check that confirms the ai-sdk-cpp package still loads.

## Acceptance criteria

- Typing `/` opens a stable Claude-style command picker; ↑/↓, Tab, Enter, and Esc behave predictably.
- `/setup sk-test-key deepseek-reasoner` stores the requested key/model pair and does not misread the key as a subcommand.
- `/help`, picker suggestions, aliases, and dispatch agree on the same supported command set.
- `/search`, `/export`, `/skills`, `/queue`, `/statusline`, and other currently implemented commands appear in the picker and execute through their existing handlers.
- Streaming text, thinking, tool calls, permission prompts, and queued messages do not desynchronize the input cursor or corrupt the terminal layout.
- The application still uses `ai-sdk-cpp` for model creation, agent execution, tool calls, and session streaming.
- `bun test`, `bun run typecheck`, and `bun run build` finish successfully.

