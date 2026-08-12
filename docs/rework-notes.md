# DeepSeek Code — Rework notes (2026-08-12)

Session notes for the "reach Claude Code quality" rework. Final docs
(CLAUDE.md/AGENTS.md) to be updated from these when the rework settles.

## Engine

- The engine is now **ai-sdk-cpp** (native C++ SDK via the Node binding), not the
  Vercel AI SDK. `src/services/provider/registry.ts` → `createDeepSeek()`.
- `Agent + Session` from the binding own the agentic loop, history, memory
  auto-inject, sliding-window compaction. `src/services/query.ts` maps native
  stream events (`text_delta`, `reasoning_start/delta/end`, `tool_call_*`,
  `step_finish`, `finish`, `error`) to `QueryEvent` for the Ink UI.
- `agentSession.ts` builds the session per (provider, model, workdir, agent,
  memoryDir) with `assembleSystemPromptSync()` (dynamic system prompt from
  `constants/prompts.ts`) + output style composition + project docs.

## Reasoning effort (NEW)

- ai-sdk-cpp Agent path now accepts `providerOptions` (threaded through the C
  API `ai_agent_options_t.provider_options_json` → C++ `ToolLoopAgentOptions`).
  OpenAI-compatible providers map `providerOptions.openai.reasoningEffort` →
  `reasoning_effort` in the API body.
- deepseek-code: `effort: off|low|medium|high|max` — persisted setting +
  `--effort` CLI flag + config-file key. `src/services/effort.ts`:
  `getEffortLevel()` (CLI > persisted) + `effortToProviderOptions()`.
  agentSession includes effort in the session cache key → next turn rebuilds
  the Agent with the new providerOptions. StatusBar shows an effort chip.

## Skills system (NEW)

- `src/skills/skillService.ts`: discovers SKILL.md from project `.claude/skills`,
  user `~/.claude/skills`, bundled `src/skills/bundled` (project > user >
  bundled precedence). Tolerant frontmatter (name/description).
- `SkillTool` (registered in tools.ts): model-invokable; its description embeds
  the discovered skill list; returns the full SKILL.md body.
- Bundled: code-review, git-commit, debugging.
- Known follow-up: `bun run build` does not copy `src/skills/bundled` into
  dist — the built binary needs a copy step (e.g. `cp -R src/skills/bundled
  dist/bundled`) or programmatic registration.

## Thinking rendering (NEW)

- Reasoning streams as **chronological, collapsed blocks** (Claude Code style):
  `∴ Thinking…` with a dim preview while streaming; `∴ Thought (ctrl+o to
  expand)` once finalized; full text in transcript mode (Ctrl+O).
- `MessageBlock` gained `type: "thinking"`. App tracks the open block via
  `thinkingOpenRef` (reasoning_start → delta → reasoning_end). ChatPanel and
  MessageView render thinking blocks in place; the old hoisted `streamingThinking`
  area and per-message `thinking` field are gone for new messages (legacy
  transcripts still render via `message.thinking`).
- exportConversation / transcriptSearch derive thinking from blocks too.

## Tools (from prior sessions)

- All registered in tools.ts: ConfigTool, SleepTool, ScheduleCronTool,
  Enter/ExitWorktreeTool, PowerShellTool, BriefTool, REPLTool, ToolSearchTool,
  TaskOutputTool, TaskStopTool, SkillTool.
- BashTool: `run_in_background` wired to `src/services/tasks/backgroundFramework.ts`
  (registerTask/readTaskOutput/killTask).
- FileRead: binary detection (NUL byte + extensions), device-file blocking,
  PDF/notebook/image support + limits module (see FileRead workstream).
- Permission rule engine: `src/services/permissions.ts` (Tool(pattern)
  allow/deny/ask rules) — first check in the tools.ts execute wrapper.

## Headless / print mode

- `deepseek-code --print <prompt>` (or `-p` reading stdin), `--output-format
  text|json|stream-json`, `--max-turns`, `--system-prompt-file`,
  `--allowed-tools` — `src/cli/print.ts`, branched in index.tsx before Ink
  renders. Reuses the query() AsyncGenerator.

## Safety

- Root/sudo gate: refuses `--dangerously-skip-permissions` as root outside a
  sandbox (index.tsx).

## Commands / wiring (Phase 2)

- /effort, /skills, /export, /search added; /rewind restores on-disk file
  snapshots (src/utils/fileHistory.ts); notifications (src/utils/notify.ts) on
  long turns; exit cost summary via src/utils/costSummary.ts + stats.json;
  engine recovery helper src/services/recovery.ts (413 → advise /compact;
  overload → fallback model retry once).

## Scratch cleanup

- Root dsc_* probe files removed at final verification (were Ink-rendering
  debug scratch: dsc_theme_probe, dsc_perm_probe, dsc_help_welcome_probe,
  dsc_chat_render_probe, dsc_history_search_probe, dsc_search_results_probe).

## Frontend port (Phase 4/5)

- UI theme + design system ported from claude-code-main:
  `src/utils/theme.ts` (dark/light palettes, mutable `theme` module, `resolveColor`
  with `ansi:` support) + `src/ui/design-system/` (ThemeProvider with
  `DEFAULT_THEME="dark"` fallback context, design tokens). `ThemeProvider` is
  mounted at the App root; `setThemeMode()` keeps the legacy mutable `theme`
  module in sync so both the new tokens and the old direct reads agree.
- Ported components (props contracts preserved from the pre-port exports):
  ChatPanel, MessageView, Markdown, ThinkingBlock, ToolBlock, Spinner, TextInput,
  MultilineTextInput, StatusBar, WelcomeScreen, HelpView, PermissionPrompt,
  StructuredDiff, HistorySearch, ExportView, SearchResultsView.
- App.tsx integration: /help → HelpView overlay (data from
  `src/constants/help.ts` — the giant inline help message is gone), /export →
  ExportView overlay (writes `deepseek-code-export-<ts>.<ext>` via
  `writeToFile`), /search → SearchResultsView overlay (jumps to the matching
  message via Inspect Mode). All overlays share the existing full-screen overlay
  pattern (gate App's useInput; Ctrl+C / Esc close them).
- Custom status line (Claude Code parity): `statusLine?: { type: "command";
  command: string }` on PersistedSettings; `/statusline <command>` sets it,
  `/statusline off` clears it, no-arg prints current config + usage. StatusBar
  renders the trimmed stdout right-aligned at the far edge while keeping all
  existing content. Execution: Bun.spawn `sh -c`, 5s AbortController timeout,
  300ms debounce, refresh after each finished turn and every ~20s, silent
  no-op on failure. **Trust-gated**: never executes when the workspace is
  untrusted (`src/services/projectTrust.ts` `isTrusted()` — same model
  claude-code uses for hooks).
- WelcomeScreen whale mascot redesigned: 4-frame × 6-line ASCII whale (spout
  droplets + jet, head/eye, tail fluke, flat belly) in block chars, frame 0
  rendered, colored with the `claude` theme token.
- Build fix: `bun run build` now copies `src/skills/bundled` → `dist/bundled`
  (resolves the "dist build must ship bundled skills" follow-up); the built
  bundle's `bundledSkillsDir()` resolves via `import.meta.dir` — verified
  against the dist layout, no skillService change needed.
- Status line + mascot verified by a throwaway FakeTTY probe under /tmp
  (14 assertions: thinking label, tool name, markdown bold styling, whale art
  within terminal width, status-line output).

## Known follow-ups

- Structured output enforcement (utils/structuredOutput.ts) needs C++
  response_format plumbing on the Agent path — deferred.
- LSP tooling, MCP server entrypoint, memdir — future phases.
