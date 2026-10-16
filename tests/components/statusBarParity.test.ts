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
    React.createElement(StatusBar, { model: "deepseek-flash", agentName: "code", ...props } as BarProps),
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
  expect(frame).toContain("  ~/proj · main\n  deepseek-flash");
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
  // Reference PermissionMode.ts: ⏵⏵ accept edits on (shift+tab to cycle).
  // It rides the row below the standard one, so it never displaces a segment
  // of the standard row.
  const acceptEdits = await renderBar({ permissionMode: "acceptEdits" });
  expect(acceptEdits).toContain("⏵⏵ accept edits on (shift+tab to cycle)");
  expect(acceptEdits).toMatch(/\n  ⏵⏵ accept edits on \(shift\+tab to cycle\)/);
  // plan → PAUSE_ICON + "Plan Mode"
  expect(await renderBar({ permissionMode: "plan" })).toContain(
    "⏸ plan mode on (shift+tab to cycle)",
  );
  expect(await renderBar({ permissionMode: "bypassPermissions" })).toContain(
    "⏵⏵ bypass permissions on (shift+tab to cycle)",
  );
  // auto mode is the wide one: every tool call settles, commands included.
  const auto = await renderBar({ permissionMode: "auto" });
  expect(auto).toContain("⏵⏵ auto mode on (shift+tab to cycle)");
  expect(auto).toMatch(/\n  ⏵⏵ auto mode on \(shift\+tab to cycle\)/);
});

test("the mode chip is there in every mode, manual included", () => {
  // The row is the app's statement about who is deciding — the agent, or you.
  // A mode that decides nothing was the one case that rendered no chip at all,
  // which read as "no mode" rather than as the mode you were in.
  return renderBar().then((frame) => {
    expect(frame).toContain("⏸ manual mode on");
    expect(frame).toMatch(/\n  ⏸ manual mode on/);
  });
});

test("the standard row is the same row before anything has been spent", async () => {
  // A fresh session — no message sent, no tokens counted. The row is still
  // there, with an empty bar, because it is the app's line and not a report
  // that appears once there is something to report.
  const frame = await renderBar({
    workingDirectory: "/srv/proj",
    branch: "main",
    branchDirty: true,
  });
  expect(frame).toContain("deepseek-flash │ /srv/proj │ ⎇ main* │ ░░░░░░░░░░ 0%");
});

test("the standard row orders model, directory, branch, context, rate, style", async () => {
  const frame = await renderBar({
    workingDirectory: "/srv/proj",
    branch: "main",
    branchDirty: false,
    contextTokens: 660,
    tokensPerSecond: 38,
    outputStyle: "concise",
    tokenBudget: { maxContextTokens: 1000, reservedForResponse: 0, compactionThreshold: 0.5 },
  });
  expect(frame).toContain("deepseek-flash │ /srv/proj │ ⎇ main │ ███████░░░ 66% │ 38 tok/s │ [concise]");
});

test("a directory outside a repository simply drops the branch segment", async () => {
  const frame = await renderBar({ workingDirectory: "/srv/proj" });
  expect(frame).toContain("deepseek-flash │ /srv/proj │ ░░░░░░░░░░ 0%");
  expect(frame).not.toContain("⎇");
});

test("the context readout is the bar's own percentage — used, not remaining", async () => {
  // The bar fills as the window fills, so the number beside it counts up too.
  // "12% until auto-compact" beside a bar that is nearly empty was the bar and
  // the number describing opposite things.
  const frame = await renderBar({
    tokenCount: 120,
    inputTokens: 120,
    outputTokens: 0,
    tokenBudget: { maxContextTokens: 1000, reservedForResponse: 0, compactionThreshold: 0.5 },
  });
  expect(frame).toContain("█░░░░░░░░░ 12%");
  expect(frame).not.toContain("until auto-compact");
});

test("a nearly full context switches to the /compact wording", async () => {
  const frame = await renderBar({
    tokenCount: 900,
    inputTokens: 900,
    outputTokens: 0,
    tokenBudget: { maxContextTokens: 1000, reservedForResponse: 0, compactionThreshold: 0.5 },
  });
  expect(frame).toContain("█████████░ 90%");
  expect(frame).toContain("Context low · Run /compact to compact & continue");
});

test("the context bar measures the conversation, not the turn that wrote it", async () => {
  // 400 tokens in a 1000-token window. The turn's own totals — 1200 in across
  // its calls, 345 written — describe the turn, not what the next request
  // sends; the engine reports both, and the bar is the second.
  const frame = await renderBar({
    contextTokens: 400,
    inputTokens: 1200,
    outputTokens: 345,
    tokenCount: 1545,
    tokenBudget: { maxContextTokens: 1000, reservedForResponse: 0, compactionThreshold: 0.5 },
  });
  expect(frame).toContain("████░░░░░░ 40%");
});

test("a reply's own tokens do not fill the window they were written into", async () => {
  // Read as input + output, a 900-token reply in a 1000-token window is a full
  // window — the reading that made the bar jump most on the longest answers.
  const frame = await renderBar({
    contextTokens: 100,
    inputTokens: 100,
    outputTokens: 900,
    tokenBudget: { maxContextTokens: 1000, reservedForResponse: 0, compactionThreshold: 0.5 },
  });
  expect(frame).toContain("█░░░░░░░░░ 10%");
});

test("a rate needs both of its halves, so there is none until there is one", async () => {
  expect(await renderBar()).not.toContain("tok/s");
  expect(await renderBar({ tokensPerSecond: 38 })).toContain("38 tok/s");
});

test("the output style is named only when one other than the default is on", async () => {
  expect(await renderBar()).not.toContain("[");
  expect(await renderBar({ outputStyle: "concise" })).toContain("│ [concise]");
});

test("the raw ↑/↓ counts are gone from the bar", async () => {
  // They restated what the bar already measures and cost the row its width.
  const frame = await renderBar({ inputTokens: 1200, outputTokens: 345 });
  expect(frame).not.toContain("↑");
  expect(frame).not.toContain("↓");
});
