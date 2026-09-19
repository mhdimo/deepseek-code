import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render } from "ink";

import StatusBar from "../../src/components/StatusBar.js";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

type BarProps = React.ComponentProps<typeof StatusBar>;

async function renderBar(props: Partial<BarProps> = {}): Promise<string> {
  let out = "";
  const stdout = Object.assign(new EventEmitter(), {
    columns: 120,
    rows: 40,
    isTTY: true,
    write: (chunk: string) => {
      out += chunk;
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as NodeJS.ReadStream;

  const app = render(
    React.createElement(StatusBar, { model: "deepseek-chat", agentName: "code", ...props } as BarProps),
    {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: false,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  app.unmount();
  app.cleanup();
  return out.replace(ANSI, "");
}

test("a custom status line gets its own row above the model row", async () => {
  // Reference PromptInputFooter: StatusLine is stacked above the footer's
  // left side — not right-aligned alongside it.
  const frame = await renderBar({ statusLineOutput: "~/proj · main" });
  expect(frame).toContain("  ~/proj · main\n  deepseek-chat");
});

test("the shortcut hint replaces the status line, never shares its row", async () => {
  const frame = await renderBar({ statusLineOutput: "~/proj · main" });
  expect(frame).not.toContain("? for shortcuts");
});

test("the idle hint is '? for shortcuts' with no history item", async () => {
  const frame = await renderBar();
  expect(frame).toContain("? for shortcuts");
  expect(frame).not.toContain("· ? for shortcuts");
  expect(frame).not.toContain("↑/↓ for history");
});

test("no permission hint is duplicated in the status bar", async () => {
  // The dialog itself renders "Esc to cancel · Tab to amend".
  const frame = await renderBar({ awaitingPermission: true });
  expect(frame).not.toContain("enter to confirm");
  expect(frame).not.toContain("esc to cancel");
});

test("permission mode shows its symbol, title and cycle hint", async () => {
  // Reference PermissionMode.ts: ⏵⏵ accept edits on (shift+tab to cycle)
  expect(await renderBar({ permissionMode: "acceptEdits" })).toContain(
    " · ⏵⏵ accept edits on (shift+tab to cycle)",
  );
  // plan → PAUSE_ICON + "Plan Mode"
  expect(await renderBar({ permissionMode: "plan" })).toContain(
    " · ⏸ plan mode on (shift+tab to cycle)",
  );
  expect(await renderBar({ permissionMode: "bypassPermissions" })).toContain(
    " · ⏵⏵ bypass permissions on (shift+tab to cycle)",
  );
});

test("the context readout is labelled, not a bare percentage", async () => {
  const frame = await renderBar({
    tokenCount: 120,
    inputTokens: 120,
    outputTokens: 0,
    tokenBudget: { maxContextTokens: 1000, reservedForResponse: 0, compactionThreshold: 0.5 },
  });
  expect(frame).toContain("88% until auto-compact");
});

test("a nearly full context switches to the /compact wording", async () => {
  const frame = await renderBar({
    tokenCount: 900,
    inputTokens: 900,
    outputTokens: 0,
    tokenBudget: { maxContextTokens: 1000, reservedForResponse: 0, compactionThreshold: 0.5 },
  });
  expect(frame).toContain("Context low (10% remaining) · Run /compact to compact & continue");
});

test("token counts carry the arrow convention and the word 'tokens'", async () => {
  // ↓ is generated (response) tokens, ↑ is what was sent — reference
  // SpinnerAnimationRow/SpinnerModeGlyph.
  const frame = await renderBar({ inputTokens: 1200, outputTokens: 345 });
  expect(frame).toContain("↑ 1.2k tokens");
  expect(frame).toContain("↓ 345 tokens");
});
