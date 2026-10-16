# DeepSeek Code inside the DeepSeek Harness

DeepSeek Code can run as a subagent of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`): the harness spawns `deepseek-code acp` as a child process and talks to
it over the **Agent Client Protocol** (ACP) — newline-delimited JSON-RPC 2.0 on
stdio. This document explains how the pieces fit, how to configure the harness,
and what to check when it doesn't work.

## How it works

```
dsh (cordis plugin: subagent-acp)
  └─ spawns: deepseek-code acp
       ├─ initialize      → handshake
       ├─ session/new     → builds the native Agent+Session for a cwd
       ├─ session/prompt  → runs one turn, streams session/update notifications
       └─ session/cancel  → stops the turn in flight (notification)
```

The child process is **the same engine the TUI and `--print` use** — the C++
Agent+Session via `getOrCreateMemorySession()`. ACP mode is a mouth, not a
brain: it adds a protocol front-end over `src/services/agent/agentSession.ts`
and nothing else. No harness code runs in this process, and nothing in the
harness is needed to build, test, or run DeepSeek Code.

Each activation gets its own child process with its own session, model, tools,
and working directory. The child does **not** see the parent's conversation
history and inherits no tools or services from the parent harness.

## Requirements

- `dsh` with the subagent system (`@deepseek-ai/dsh-subagent-acp` plugin).
- `deepseek-code` on the PATH of the harness process (or an absolute path in
  `command`). `bun dist/index.js --acp` works too.
- A DeepSeek API key, passed as described below.

## Configuration

The `subagent-acp` backend takes a command to spawn per child. In your cordis
config (e.g. `cordis.yml`):

```yaml
subagent-acp:
  providerName: acp
  command: deepseek-code
  args: [acp]
  # 'reject' (default) refuses every tool-permission prompt;
  # 'allow' approves them via the first allow_once option.
  permission: reject
  env:
    # The harness spawns the child with a credential-scrubbed copy of its own
    # environment, so name the key explicitly here — an ambient DEEPSEEK_API_KEY
    # is not forwarded implicitly.
    DEEPSEEK_API_KEY: <your key>
```

Fields:

- `command` / `args` — what to spawn. `command: deepseek-code, args: [acp]`.
- `permission` — how the harness answers our `session/request_permission`
  requests. `reject` (default) declines every tool; `allow` picks the first
  `allow_once`/`allow_always` option. No prompt ever reaches a human.
- `env` — extra environment for the child, forwarded on top of the
  credential-scrubbed environment.
- `disposeEofGraceMs` / `disposeGraceMs` — how long the harness waits for the
  child to exit after closing stdin, and after a termination signal. Defaults
  are fine; we exit promptly when stdin ends.

Any tool the model wants to use still goes through the child's own
configuration: MCP servers from the child's `.deepseek-code.json`, its own
permission rules, its own output style.

## Permissions

Every tool call the engine wants to run becomes a `session/request_permission`
request to the harness, with the tool name, a description, and two options
(`allow_once`, `reject_once`). The harness's `permission:` policy decides:

- `reject` → the child is told the request was cancelled, the tool does not
  run, and the refusal is handed to the model as the tool result, so it can
  explain what it couldn't do and keep going.
- `allow` → the tool runs.

There is one important consequence of `reject` (the default): the child agent
can read its own configuration, think, and answer, but effectively cannot
touch files or run commands. If a task needs that, either set `permission:
allow`, or rely on the child's own permission rules (e.g. an `allow` rule for
`Read` in its settings lets Read work without a prompt — rules are consulted
before the client is asked).

## What the harness sees

The `subagent-acp` backend folds **`agent_message_chunk` text** into the
subagent result — the final answer. Reasoning (`agent_thought_chunk`) and
tool-call cards (`tool_call` / `tool_call_update`) are sent so a UI could
render them, but this backend ignores them.

Stop reasons map as:

| Our answer         | Meaning                                        | Harness reads |
| ------------------ | ---------------------------------------------- | ------------- |
| `end_turn`         | the turn finished                              | completed     |
| `cancelled`        | `session/cancel` stopped it                    | aborted       |
| `max_turn_requests`| the 25-step budget ran out (answer truncated)  | error         |
| `max_tokens`       | the model hit its output cap                   | max-tokens    |

A dead turn (engine error, or a turn that produced no output at all) **rejects**
the `session/prompt` request. It never masquerades as an empty successful
answer.

## Troubleshooting

- **`deepseek-code acp: no API key configured` on stderr, exit 1.** The child
  was spawned without a key — see `env:` above. (Credentials in the parent's
  environment are scrubbed, so exporting the key in the harness's own shell is
  not enough.)
- **Child exits immediately with 0.** It received EOF on stdin before any
  request; the harness closed stdin. Normal at teardown, a bug otherwise.
- **Everything is denied.** That is the default (`permission: reject`). Set
  `permission: allow`, or add allow rules to the child's settings.
- **Nothing on stdout but a stack trace on stderr.** stdout is protocol-only
  by design; all diagnostics go to stderr, which the harness inherits.
- **Timeouts on `session/new`.** The child builds the native session and
  contacts configured MCP servers during `session/new`, not lazily. A hanging
  MCP server delays it; `[mcp] connecting to "…"` lines on stderr say which.

## Implementation notes (for this repo)

- `src/cli/acp.ts` — the protocol core (`createAcpAgent`), the stdio transport
  (`connectAcp`), and the real engine runtime (`runAcp`). The protocol core
  takes an injected runtime, so the wire behavior is tested without the native
  binding.
- `src/index.tsx` — the `--acp` branch, beside the `--print` branch.
- `tests/cli/acp.test.ts` — drives the agent with the same
  `@agentclientprotocol/sdk` client the harness uses (`connectWith` in-process
  plus a raw stream pair), so wire compatibility is asserted against the real
  SDK, not a mock of it.
- Cancellation mirrors the rest of the codebase: the engine has no interrupt
  API, so `session/cancel` aborts the turn's `AbortController` and the consumer
  breaks its stream loop (`src/services/query.ts` does the same).
- Not implemented: `session/load`, client `fs/*` and `terminal/*` callbacks
  (the child serves itself), and auth methods (`initialize` advertises none).
  One prompt runs at a time per session.
