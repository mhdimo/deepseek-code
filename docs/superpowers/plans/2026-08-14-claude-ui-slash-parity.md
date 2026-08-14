# Claude-Style UI and Slash-Command Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the supported DeepSeek Code terminal experience visually and behaviorally match the supplied Claude Code reference while keeping ai-sdk-cpp as the native agent/session engine.

**Architecture:** Add a pure command registry and parser that becomes the single source for autocomplete, help, aliases, and dispatch lookup. Keep stateful command effects in `App.tsx`, and make focused Ink changes for full redraws, Claude-style picker rows, prompt markers, and stable transcript/prompt composition.

**Tech Stack:** Bun, TypeScript, React 19, Ink 6, Zod, ai-sdk-cpp Node binding, Bun test runner.

**Spec:** `docs/superpowers/specs/2026-08-14-claude-ui-slash-parity-design.md`

## Global Constraints

- “Parity means matching the observable terminal behavior and visual hierarchy—not copying Claude Code’s Anthropic-specific runtime, private services, or unavailable product features.”
- “The existing flow remains authoritative.”
- “UI work may change how `QueryEvent` values are stored or rendered, but it must not recreate the agent loop in TypeScript, manually compact history, or replace `Session.sendStream()` with a different provider SDK.”
- “The root renderer will use full redraw mode (`incrementalRendering: false`).”
- “Unsupported Claude commands will not be advertised as available.”
- “Tests will be written before implementation for each pure behavior.”
- Do not add `Co-authored-by` trailers to commits.
- Preserve the user’s unrelated untracked `/Users/liang/deepseek-code/pitch.html` file.

---

## File Map

- `src/services/commands/commandRegistry.ts` — canonical built-in definitions, parsing, alias resolution, suggestion ranking, command merging, and help/picker projections.
- `src/services/customCommands.ts` — adapt custom Markdown commands to the canonical registry shape without changing placeholder expansion.
- `src/components/CommandPicker.tsx` — render the canonical suggestions with Claude-style width-aware rows.
- `src/components/commandPickerLayout.ts` — pure width, truncation, and visible-range calculations used by the picker.
- `src/constants/help.ts` — generate help groups from the canonical registry while retaining keyboard shortcut text and help intro/footer.
- `src/components/App.tsx` — consume parsed commands and canonical definitions; correct `/setup` parsing and preserve existing stateful handlers.
- `src/index.tsx` — disable Ink incremental rendering.
- `src/components/MessageView.tsx` — render user messages with the Claude-style prompt marker and preserve chronological assistant blocks.
- `src/components/ChatPanel.tsx` — make the transcript region shrinkable and clipping-safe inside the fixed terminal-height layout.
- `src/components/TextInput.tsx` — keep the prompt/input/footer composition stable with the new picker and width helpers.
- `src/components/terminalLayout.ts` — pure terminal-width/height helpers for prompt and transcript layout.
- `tests/commands/commandRegistry.test.ts` — parser, aliases, ranking, merging, and projection tests.
- `tests/commands/setupArgs.test.ts` — regression coverage for `/setup <key> [model]`.
- `tests/ui/commandPickerLayout.test.ts` — picker width, truncation, and visible-range tests.
- `tests/ui/terminalLayout.test.ts` — terminal layout helper tests.

## Interfaces

The registry will expose these stable types and functions:

```ts
export type CommandCategory = "general" | "session" | "model" | "agent" | "mcp" | "project";

export interface CommandDefinition {
  name: string; // canonical name without /
  description: string;
  category: CommandCategory;
  aliases?: readonly string[];
  usage?: readonly string[];
  argumentHint?: string;
  acceptsArgs?: boolean;
  executionKey: string;
}

export interface ParsedSlashCommand {
  canonicalName: string;
  args: string[];
  rawArgs: string;
  input: string;
}

export const BUILTIN_COMMANDS: readonly CommandDefinition[];
export function parseSlashCommand(input: string): ParsedSlashCommand | null;
export function parseSetupArguments(parsed: ParsedSlashCommand): { apiKey: string; model?: string } | null;
export function resolveCommandName(name: string): string | null;
export function filterCommandDefinitions(input: string, extras?: readonly CommandDefinition[]): CommandDefinition[];
export function mergeCommandDefinitions(...groups: readonly CommandDefinition[][]): CommandDefinition[];
export function getHelpGroups(): Array<{ title: string; commands: CommandDefinition[] }>;
```

`CommandPicker` will continue accepting a `commands` array and `selectedIndex`, but will consume `CommandDefinition[]` directly. `App.tsx` will call `parseSlashCommand()` before the existing handler switch and use `canonicalName` for the switch key.

---

### Task 1: Build the canonical command registry

**Files:**
- Create: `src/services/commands/commandRegistry.ts`
- Create: `tests/commands/commandRegistry.test.ts`

**Interfaces:**
- Produces `CommandDefinition`, `ParsedSlashCommand`, `BUILTIN_COMMANDS`, `parseSlashCommand`, `resolveCommandName`, `filterCommandDefinitions`, `mergeCommandDefinitions`, and `getHelpGroups` for later tasks. `parseSetupArguments()` is added in Task 3 after the parser contract is in place.
- Does not import React, Ink, `App.tsx`, provider code, or stateful services.

- [ ] **Step 1: Write the failing parser and alias tests**

Create `tests/commands/commandRegistry.test.ts` with real pure-function assertions:

```ts
import { describe, expect, test } from "bun:test";
import {
  filterCommandDefinitions,
  mergeCommandDefinitions,
  parseSlashCommand,
  resolveCommandName,
} from "../../src/services/commands/commandRegistry.js";

describe("command registry", () => {
  test("parses a canonical command and preserves the raw argument string", () => {
    expect(parseSlashCommand("/model deepseek-reasoner")).toEqual({
      canonicalName: "model",
      args: ["deepseek-reasoner"],
      rawArgs: "deepseek-reasoner",
      input: "/model deepseek-reasoner",
    });
  });

  test("resolves aliases case-insensitively", () => {
    expect(resolveCommandName("/quit")).toBe("exit");
    expect(resolveCommandName("/?")).toBe("help");
    expect(resolveCommandName("/USAGE")).toBe("usage");
  });

  test("parses quoted arguments containing spaces", () => {
    expect(parseSlashCommand('/statusline "git branch --show-current"')).toMatchObject({
      canonicalName: "statusline",
      args: ["git branch --show-current"],
      rawArgs: '"git branch --show-current"',
    });
  });

  test("ranks exact and prefix matches before description matches", () => {
    const names = filterCommandDefinitions("/co").map((command) => command.name);
    expect(names.slice(0, 3)).toEqual(["compact", "config", "context"]);
  });

  test("merges command groups by canonical name and keeps the first definition", () => {
    const merged = mergeCommandDefinitions(
      [{ name: "demo", description: "built-in", category: "general", executionKey: "demo" }],
      [{ name: "/demo", description: "custom", category: "session", executionKey: "custom" }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.description).toBe("built-in");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails for the missing module**

Run: `bun test tests/commands/commandRegistry.test.ts`

Expected: FAIL because `src/services/commands/commandRegistry.ts` does not exist yet.

- [ ] **Step 3: Implement the registry and parser**

Create the `src/services/commands` directory and implement:

1. `BUILTIN_COMMANDS` in the order used by the current supported help surface, with canonical names without `/`, all aliases currently advertised, and `executionKey` equal to the canonical name.
2. `resolveCommandName()` that trims input, removes one leading `/`, lowercases it, and resolves aliases through a `Map`.
3. `parseSlashCommand()` that returns `null` for non-slash input or an empty command, splits only the command token from the argument tail, and tokenizes single-quoted, double-quoted, escaped, and unquoted arguments without shell execution.
4. `filterCommandDefinitions()` that only returns suggestions for a slash-prefixed single token, treats `/` as the empty query, ranks exact name, exact alias, name prefix, alias prefix, name substring, alias substring, and description substring, then sorts ties alphabetically and deduplicates canonical names.
5. `mergeCommandDefinitions()` that normalizes leading slashes, preserves first-seen canonical definitions, and returns a new array.
6. `getHelpGroups()` that projects the built-in registry into the six existing help sections: Setup & model, Agents & reasoning, Project, Sessions & history, Git & diagnostics, and System.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bun test tests/commands/commandRegistry.test.ts`

Expected: PASS with all registry assertions green.

- [ ] **Step 5: Run typecheck and commit the registry**

Run: `bun run typecheck`

Expected: exit 0.

Commit only the task files:

```bash
git add src/services/commands/commandRegistry.ts tests/commands/commandRegistry.test.ts
git commit -m "feat: add canonical slash command registry"
```

---

### Task 2: Make custom commands, picker metadata, and help use the registry

**Files:**
- Modify: `src/services/customCommands.ts`
- Modify: `src/components/CommandPicker.tsx`
- Modify: `src/constants/help.ts`
- Modify: `tests/commands/commandRegistry.test.ts`

**Interfaces:**
- Consumes `CommandDefinition`, `BUILTIN_COMMANDS`, `filterCommandDefinitions`, `mergeCommandDefinitions`, and `getHelpGroups` from Task 1.
- `toCommandDefs()` returns `CommandDefinition[]` for custom commands, with `executionKey: "custom"` and the custom name as the dispatch lookup value in metadata if needed.
- `CommandPicker` exports `filterCommands()` as a compatibility wrapper for the current `App.tsx` import; the wrapper delegates to `filterCommandDefinitions()`.

- [ ] **Step 1: Add failing projection and deduplication assertions**

Extend `tests/commands/commandRegistry.test.ts`:

```ts
test("help and picker projections share the same canonical built-ins", () => {
  const helpNames = getHelpGroups().flatMap((group) => group.commands.map((command) => command.name));
  const pickerNames = new Set(filterCommandDefinitions("/").map((command) => command.name));
  expect(helpNames).toContain("search");
  expect(helpNames).toContain("export");
  expect(helpNames).toContain("skills");
  expect(pickerNames.has("search")).toBe(true);
  expect(pickerNames.has("export")).toBe(true);
  expect(pickerNames.has("skills")).toBe(true);
});

test("extra command definitions cannot duplicate a built-in alias target", () => {
  const commands = filterCommandDefinitions("/he", [
    { name: "/help", description: "duplicate", category: "general", executionKey: "custom" },
  ]);
  expect(commands.filter((command) => command.name === "help")).toHaveLength(1);
});
```

- [ ] **Step 2: Run the projection tests to verify the current duplicated lists fail**

Run: `bun test tests/commands/commandRegistry.test.ts`

Expected: FAIL until the help and picker definitions are driven by the registry.

- [ ] **Step 3: Adapt custom command definitions**

Update `toCommandDefs()` in `src/services/customCommands.ts` to return canonical command definitions. Keep `renderCommand()` unchanged. Normalize each custom command name by removing a leading `/`, set `category: "session"`, `executionKey: "custom"`, preserve `description`, and set `usage` to the argument hint when present.

- [ ] **Step 4: Replace the picker’s duplicated built-in list**

In `src/components/CommandPicker.tsx`:

- remove the local `ALL_COMMANDS` array and ranking implementation;
- import `BUILTIN_COMMANDS` and `filterCommandDefinitions` from the registry;
- re-export `BUILTIN_COMMANDS` as `ALL_COMMANDS` for the existing `App.tsx` import during the transition;
- keep the `CommandDef` type as a type alias to `CommandDefinition` if needed for compatibility;
- make `filterCommands()` delegate to `filterCommandDefinitions()`.

- [ ] **Step 5: Derive help groups from the registry**

In `src/constants/help.ts`, retain `HELP_INTRO`, `HELP_FOOTER`, and `KEYBOARD_SHORTCUTS`, but replace the manually duplicated command group list with `getHelpGroups()` mapped to `HelpCommand` objects. Preserve `allCommandNames()` by flattening the derived groups.

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test tests/commands/commandRegistry.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit the shared metadata integration**

```bash
git add src/services/customCommands.ts src/components/CommandPicker.tsx src/constants/help.ts src/components/HelpView.tsx tests/commands/commandRegistry.test.ts
git commit -m "refactor: share slash command metadata across UI"
```

---

### Task 3: Fix slash parsing and App dispatch without changing command effects

**Files:**
- Create: `tests/commands/setupArgs.test.ts`
- Modify: `src/components/App.tsx`
- Modify: `src/services/commands/commandRegistry.ts` if a small pure setup-argument helper is needed

**Interfaces:**
- Consumes `parseSlashCommand()` and `resolveCommandName()` from Task 1.
- `App.tsx` switches on `parsed.canonicalName` and obtains arguments from `parsed.args`.
- Stateful command behavior remains in the existing `handleCommand()` callback.

- [ ] **Step 1: Write the failing `/setup` regression test**

Add a pure helper to the registry contract and test it before implementation:

```ts
import { describe, expect, test } from "bun:test";
import { parseSetupArguments } from "../../src/services/commands/commandRegistry.js";

describe("setup command arguments", () => {
  test("treats the first argument as the API key and the second as the optional model", () => {
    expect(parseSetupArguments(parseSlashCommand("/setup sk-test-key deepseek-reasoner")!)).toEqual({
      apiKey: "sk-test-key",
      model: "deepseek-reasoner",
    });
  });

  test("returns no setup payload when the command has no key", () => {
    expect(parseSetupArguments(parseSlashCommand("/setup")!)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the regression test and verify it fails**

Run: `bun test tests/commands/setupArgs.test.ts`

Expected: FAIL because `parseSetupArguments()` is not defined.

- [ ] **Step 3: Implement the pure setup helper**

Add:

```ts
export function parseSetupArguments(parsed: ParsedSlashCommand): { apiKey: string; model?: string } | null {
  const apiKey = parsed.canonicalName === "setup" ? parsed.args[0]?.trim() : undefined;
  if (!apiKey) return null;
  const model = parsed.args[1]?.trim() || undefined;
  return { apiKey, model };
}
```

- [ ] **Step 4: Update `App.tsx` to use parsed canonical commands**

At the top of `handleCommand()` replace `cmd.trim().split(/\s+/)` with `parseSlashCommand(cmd)`. Return `false` when parsing returns `null`, set `command` to `parsed.canonicalName`, `arg` to `parsed.args[0]`, and `restArgs` to `parsed.args`.

Change every existing switch label from its slash form (`case "/help"`) to the canonical form (`case "help"`). Keep the original command available as `parsed.input` for messages and custom/plugin prompt submission.

In `/setup`:

- use `parseSetupArguments(parsed)`;
- show the existing usage message when it returns `null`;
- set `key` to `setup.apiKey`;
- set `resolvedModel` to `setup.model || "deepseek-chat"`;
- preserve the existing settings persistence and success message.

The rest of the handler switch continues using `command` without a leading slash. Update the custom/plugin fallback to use `command` as the already-normalized canonical name, and preserve `parsed.input` when submitting a custom/plugin prompt so the transcript still shows the user’s original slash input.

- [ ] **Step 5: Run the regression and typecheck**

Run: `bun test tests/commands/setupArgs.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit slash dispatch fixes**

```bash
git add src/services/commands/commandRegistry.ts src/components/App.tsx tests/commands/setupArgs.test.ts
git commit -m "fix: parse slash command arguments consistently"
```

---

### Task 4: Add width-aware Claude-style command picker layout

**Files:**
- Create: `src/components/commandPickerLayout.ts`
- Create: `tests/ui/commandPickerLayout.test.ts`
- Modify: `src/components/CommandPicker.tsx`

**Interfaces:**
- Produces pure helpers:

```ts
export function commandColumnWidth(columns: number): number;
export function truncateCommandDescription(description: string, width: number): string;
export function visibleCommandRange(total: number, selected: number, maxVisible?: number): { start: number; end: number };
```

- `CommandPicker` uses these helpers and renders at most six rows.

- [ ] **Step 1: Write failing layout tests**

Create `tests/ui/commandPickerLayout.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  commandColumnWidth,
  truncateCommandDescription,
  visibleCommandRange,
} from "../../src/components/commandPickerLayout.js";

describe("command picker layout", () => {
  test("keeps a usable command column on narrow terminals", () => {
    expect(commandColumnWidth(40)).toBe(16);
    expect(commandColumnWidth(100)).toBe(40);
  });

  test("truncates descriptions to one terminal row", () => {
    expect(truncateCommandDescription("a long command description", 10)).toBe("a long co…");
    expect(truncateCommandDescription("short", 10)).toBe("short");
  });

  test("centers the selected row inside a six-row window", () => {
    expect(visibleCommandRange(20, 10)).toEqual({ start: 7, end: 13 });
    expect(visibleCommandRange(20, 1)).toEqual({ start: 0, end: 6 });
    expect(visibleCommandRange(3, 1)).toEqual({ start: 0, end: 3 });
  });
});
```

- [ ] **Step 2: Run the layout tests and verify they fail**

Run: `bun test tests/ui/commandPickerLayout.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the pure layout helpers**

Use `Math.max(16, Math.min(40, Math.floor(columns * 0.4)))` for the command column, reserve at least one character for the ellipsis, collapse whitespace in descriptions, and clamp the selected window to `[0, total]` with a default maximum of six rows.

- [ ] **Step 4: Run the layout tests and verify they pass**

Run: `bun test tests/ui/commandPickerLayout.test.ts`

Expected: PASS.

- [ ] **Step 5: Refactor `CommandPicker` to use the helpers and Claude-style rows**

Render a row as a single `Text` line with:

```text
<command padded to commandColumnWidth>  <description truncated to remaining width>
```

Use `theme.suggestion`/`resolveColor()` for the selected command and dim unselected commands. Add a leading selected marker only when it fits the available width. Use `visibleCommandRange()` instead of the current fixed 34-column padding and ten-row window. Keep top/bottom ellipses when the visible range is clipped.

- [ ] **Step 6: Run picker tests, typecheck, and commit**

Run: `bun test tests/ui/commandPickerLayout.test.ts tests/commands/commandRegistry.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: exit 0.

```bash
git add src/components/commandPickerLayout.ts src/components/CommandPicker.tsx tests/ui/commandPickerLayout.test.ts
git commit -m "feat: match Claude-style command picker layout"
```

---

### Task 5: Stabilize Ink composition and message rows

**Files:**
- Create: `src/components/terminalLayout.ts`
- Create: `tests/ui/terminalLayout.test.ts`
- Modify: `src/index.tsx`
- Modify: `src/components/App.tsx`
- Modify: `src/components/ChatPanel.tsx`
- Modify: `src/components/MessageView.tsx`
- Modify: `src/components/TextInput.tsx`

**Interfaces:**
- Produces:

```ts
export function safeTerminalRows(rows: number | undefined, fallback?: number): number;
export function separatorWidth(columns: number): number;
export function transcriptContainerHeight(rows: number, promptRows: number): number;
```

- `ChatPanel` and the transcript child use `minHeight={0}` so the fixed terminal-height root can shrink and clip cleanly.
- `MessageView` keeps `MessageBlock` ordering and changes only the user-row presentation.

- [ ] **Step 1: Write failing terminal layout tests**

Create `tests/ui/terminalLayout.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  safeTerminalRows,
  separatorWidth,
  transcriptContainerHeight,
} from "../../src/components/terminalLayout.js";

describe("terminal layout", () => {
  test("uses safe fallbacks for missing or tiny terminal dimensions", () => {
    expect(safeTerminalRows(undefined)).toBe(40);
    expect(safeTerminalRows(0)).toBe(40);
    expect(separatorWidth(0)).toBe(1);
    expect(separatorWidth(80)).toBe(80);
  });

  test("reserves prompt rows without producing negative transcript height", () => {
    expect(transcriptContainerHeight(40, 6)).toBe(34);
    expect(transcriptContainerHeight(4, 6)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the layout tests and verify they fail**

Run: `bun test tests/ui/terminalLayout.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the layout helpers**

Use a default of 40 rows, clamp terminal rows and columns to at least 1, and return `Math.max(0, rows - promptRows)` for transcript height.

- [ ] **Step 4: Run the layout tests and verify they pass**

Run: `bun test tests/ui/terminalLayout.test.ts`

Expected: PASS.

- [ ] **Step 5: Disable Ink incremental rendering**

In `src/index.tsx`, change the `render()` options from:

```ts
{ incrementalRendering: true }
```

to:

```ts
{ incrementalRendering: false }
```

Keep `AlternateScreen` and the existing debounced resize handling intact.

- [ ] **Step 6: Make the transcript region shrinkable and the prompt width-safe**

In `ChatPanel.tsx`, add `minHeight={0}` to the root and the message-list column. In `App.tsx`’s fixed-height composition, preserve the `flexGrow={1}`/`overflow="hidden"` transcript region and use the terminal helper for safe row values if the current inline fallback is touched. In `TextInput.tsx`, replace direct separator repeat counts with `separatorWidth()` and keep the current `── <cwd>` label format.

- [ ] **Step 7: Match user message rows to the Claude prompt marker**

In `MessageView.tsx`, render user messages as a row with a themed `❯` marker and a wrapping content column. Preserve the message text exactly and leave assistant/system/tool block ordering unchanged. Do not alter the native event flow.

- [ ] **Step 8: Run focused tests, typecheck, and commit**

Run: `bun test tests/ui/terminalLayout.test.ts tests/ui/commandPickerLayout.test.ts tests/commands/commandRegistry.test.ts tests/commands/setupArgs.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: exit 0.

```bash
git add src/index.tsx src/components/App.tsx src/components/ChatPanel.tsx src/components/MessageView.tsx src/components/TextInput.tsx src/components/terminalLayout.ts tests/ui/terminalLayout.test.ts
git commit -m "fix: stabilize Claude-style terminal rendering"
```

---

### Task 6: Integrate canonical suggestions into App and verify the full workflow

**Files:**
- Modify: `src/components/App.tsx`
- Modify: `src/components/CommandPicker.tsx` only for final type adjustments
- Modify: `src/services/customCommands.ts` only for final custom/plugin metadata adjustments

**Interfaces:**
- Consumes the registry and picker APIs from Tasks 1–4.
- Produces an App flow where built-ins, custom commands, plugin commands, and aliases all use one suggestion/dispatch path.

- [ ] **Step 1: Make App suggestion state use one merged command list**

Replace the current ad hoc `ALL_COMMANDS + pluginCommands + customCommands` merge with `mergeCommandDefinitions(BUILTIN_COMMANDS, pluginCommands, toCommandDefs(customCommands))`, then call `filterCommandDefinitions(input, mergedCommands)`. Keep plugin manifest loading and custom Markdown loading unchanged.

When a picker item is selected, use its canonical name and `usage?.[0]` to insert an argument hint. For aliases typed directly, `handleCommand()` resolves them before dispatch.

- [ ] **Step 2: Preserve command-picker navigation priorities**

Verify the existing `useInput` priority order remains:

1. onboarding/overlays/permission prompt;
2. transcript/inspect mode;
3. file mentions;
4. command picker ↑/↓/Tab/Enter/Esc;
5. todo expansion;
6. input history.

Only adjust conditions that currently depend on the old `filteredCommands` shape. Do not let arrow keys leak into history while the picker is active.

- [ ] **Step 3: Run the full automated suite and typecheck**

Run: `bun test`

Expected: all tests pass with zero failures.

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 4: Build and smoke-test the native boundary**

Run: `bun run build`

Expected: exit 0 and `dist/index.js` is produced with bundled skills.

Run: `bun dist/index.js --version`

Expected: prints `DeepSeek Code v0.1.0` and exits 0, proving the built executable loads its native addon.

Run: `bun dist/index.js --print "Reply with exactly: native-ok" --max-turns 1` with the configured API key available.

Expected: the headless path completes through the existing ai-sdk-cpp session and prints the model response; if no API key is configured, record that the command reaches the existing configuration error rather than changing provider behavior.

- [ ] **Step 5: Manually smoke-test the interactive UI**

Launch `bun run dev` in a terminal at 80 columns or wider and verify:

- `/` opens a width-safe picker with selected/unselected styling;
- ↑/↓ moves within the picker and does not change history;
- Tab inserts `/setup ` or another command usage hint;
- Enter executes `/help` and `/setup sk-test-key deepseek-reasoner` locally;
- `/search`, `/export`, `/skills`, `/queue`, and `/statusline` are discoverable;
- Esc dismisses the picker, interrupts a stream, and leaves overlays in the existing priority order;
- streamed assistant text, thinking, tool rows, permission prompts, and queued messages redraw without cursor drift.

- [ ] **Step 6: Review the diff and commit the integration**

Run: `git diff HEAD~1..HEAD --stat` and `git status --short`.

Confirm only intended source/tests/docs changed and the unrelated `pitch.html` remains untracked. Then commit any final integration changes:

```bash
git add src/components/App.tsx src/components/CommandPicker.tsx src/services/customCommands.ts
git commit -m "feat: integrate Claude-style command workflow"
```

---

## Final verification checklist

- [ ] `bun test` passes.
- [ ] `bun run typecheck` passes.
- [ ] `bun run build` passes.
- [ ] `bun dist/index.js --version` loads the ai-sdk-cpp native addon.
- [ ] Interactive picker and command smoke tests pass at a normal terminal width.
- [ ] No command metadata remains duplicated between picker and help.
- [ ] No Claude-only command is advertised without a supported implementation.
- [ ] No ai-sdk-cpp/session/provider replacement was introduced.
- [ ] Commits contain no `Co-authored-by` trailer.
