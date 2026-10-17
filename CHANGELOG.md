# Changelog

All notable changes to DeepSeek Code are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-17

### Added

- **Shell mode answers its own output.** `!command` still runs the line in your
  shell, and the model now receives the output and briefly explains it — what
  happened, anything notable, and what to do next if something failed. This is
  Claude Code's `respondToBashCommands` behavior, on by default. Set
  `"respondToBashCommands": false` in `~/.deepseek-code/settings.json` (or a
  config file) to keep the output waiting for your next prompt instead.
- **Self-update.** `deepseek-code update` checks the npm registry for a newer
  published version and installs it with the package manager that owns the
  running copy (npm or bun, detected from the install path). `/update` does the
  same from inside the app and reports the result. A once-a-day startup check
  shows a one-line notice when an update exists; disable it with
  `DEEPSEEK_CODE_NO_UPDATE_CHECK=1` or `--no-update-check`.
- **Release notes.** `deepseek-code changelog` prints this file from the
  installed package; `/changelog` shows it in the transcript.
- **First-party web search and fetch.** `WebSearch` now calls DeepSeek's Search
  API — structured results with titles, URLs, and summaries written for a
  model — and `WebFetch` calls the Fetch API, which returns page content as
  Markdown. Both use the configured API key and are billed per successful
  request ($0.75 per 1,000). Without a key, or when the API declines a page,
  the previous DuckDuckGo search and direct download paths remain as fallbacks.
- `/update` and `/changelog` appear in the command picker and `/help`.

### Fixed

- A leading `!` is consumed as the shell-mode switch, so typing `!ls` no longer
  leaves a stray `!` at the start of the command.
- A lone Esc in the prompt settles immediately instead of waiting for another
  keypress to disambiguate an escape sequence.

### Changed

- The native engine is now `ai-sdk-cpp` 1.0.1, which reports structured error
  codes on failed calls and declares `finishReason` in its stream types.
- The test suite pins its colour and width, so results no longer depend on the
  terminal that runs it.

## [0.1.0] - 2026-10-16

First published release, as `@mihaldmo/deepseek-code` on npm.

- Terminal-native TUI built with Ink, with streaming text, thinking blocks,
  tool blocks, permission prompts, pickers, and a mouse click layer.
- Native agent engine (`ai-sdk-cpp`): multi-step tool loop, memory, and context
  compaction owned by the C++ session.
- Three agents (code, plan, review) plus custom agents from
  `.claude/agents/*.md`.
- Built-in tools: Read, Write, Edit, Bash, Glob, Grep, LS, WebFetch, WebSearch,
  NotebookEdit, TodoWrite, Task tools, Agent, AskUserQuestion, plan mode,
  worktrees, skills, background tasks, and more.
- MCP servers, hooks, permission rules, skills, workflows, sessions, rewind,
  export, custom status line, and DeepSeek reasoning-effort control.
- Headless `--print` mode (text or JSON) and the Agent Client Protocol (`--acp`)
  for the DeepSeek Harness.

[Unreleased]: https://github.com/mhdimo/deepseek-code/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/mhdimo/deepseek-code/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mhdimo/deepseek-code/releases/tag/v0.1.0
