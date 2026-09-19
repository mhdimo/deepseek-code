import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render } from "ink";

import AgentFanout, { buildAgentFanoutLines } from "../../src/components/AgentFanout.js";
import { BLACK_CIRCLE } from "../../src/components/ToolBlock.js";
import { getTheme, resolveColor } from "../../src/utils/theme.js";
import type { ToolUseBlock } from "../../src/types/index.js";

const theme = getTheme("dark");
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

const agent = (partial: Partial<ToolUseBlock> & { toolCallId: string }): ToolUseBlock => ({
  toolName: "Agent",
  status: "running",
  argsJson: JSON.stringify({ subagent_type: "explore", description: "map" }),
  input: "map",
  output: "",
  ...partial,
});

const text = (l: { segments: { text: string }[] }): string =>
  l.segments.map((s) => s.text).join("");

async function renderFanout(node: React.ReactElement, waitMs = 60): Promise<string> {
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

  const app = render(node, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
  });
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  app.unmount();
  app.cleanup();
  return out.replace(ANSI, "");
}

test("the loader bullet is drawn in every state", () => {
  const running = buildAgentFanoutLines([agent({ toolCallId: "a", output: "⎿ Reading x\n" })], theme);
  const runBullet = running[0]!.segments[0]!;
  expect(runBullet.text).toBe(`${BLACK_CIRCLE} `);
  // Unresolved: dim, no explicit colour (and it blinks).
  expect(runBullet.dim).toBe(true);
  expect(runBullet.color).toBeUndefined();
  expect(runBullet.blink).toBe(true);

  const done = buildAgentFanoutLines(
    [agent({ toolCallId: "a", status: "done", output: "Done (3 tool uses · 10 tokens · 1s)\n" })],
    theme,
  );
  const doneBullet = done[0]!.segments[0]!;
  expect(doneBullet.text).toBe(`${BLACK_CIRCLE} `);
  expect(doneBullet.color).toBe(resolveColor(theme.success));
  expect(doneBullet.dim).toBeFalsy();
  expect(doneBullet.blink).toBeFalsy();

  const failed = buildAgentFanoutLines([agent({ toolCallId: "a", status: "error", output: "✗ boom" })], theme);
  expect(failed[0]!.segments[0]!.color).toBe(resolveColor(theme.error));
});

test("an errored agent row carries no ' · failed' suffix", () => {
  const lines = buildAgentFanoutLines([agent({ toolCallId: "a", status: "error", output: "✗ boom" })], theme);
  expect(text(lines[1]!)).not.toContain("failed");
});

test("a backgrounded agent gets no '⎿ Running in the background' line", () => {
  const lines = buildAgentFanoutLines(
    [agent({ toolCallId: "a", status: "done", output: "Background agent launched (task b1).\n" })],
    theme,
  );
  // Header + agent row only.
  expect(lines).toHaveLength(2);
  expect(lines.map(text).join("\n")).not.toContain("Running in the background");
});

test("the background header prompts '(↓ to manage)'", () => {
  const lines = buildAgentFanoutLines(
    [agent({ toolCallId: "a", status: "done", output: "Background agent launched (task b1).\n" })],
    theme,
  );
  expect(text(lines[0]!)).toContain("1 background agents launched (↓ to manage)");
});

test("the ctrl+o hint is separated by a single space", () => {
  const lines = buildAgentFanoutLines(
    [agent({ toolCallId: "a", status: "done", output: "Done (3 tool uses · 10 tokens · 1s)\n" })],
    theme,
  );
  expect(text(lines[0]!)).toContain("finished (ctrl+o to expand)");
});

test("agent rows are indented 3 columns, the header is not", () => {
  const lines = buildAgentFanoutLines(
    [agent({ toolCallId: "a", output: "⎿ Reading x\n" })],
    theme,
  );
  expect(lines[0]!.paddingLeft).toBeUndefined();
  expect(lines[1]!.paddingLeft).toBe(3);
  expect(lines[2]!.paddingLeft).toBe(3);
});

test("the rendered tree is indented inside the transcript", async () => {
  const frame = await renderFanout(
    React.createElement(AgentFanout, {
      blocks: [agent({ toolCallId: "a", output: "⎿ Reading x\n" })],
    }),
  );
  expect(frame).toContain("   └─");
  expect(frame).toContain("   ⎿  Reading x");
});

test("the running bullet blanks on the reference's blink cadence", async () => {
  // Reference useBlink: the unresolved loader bullet alternates with a blank
  // space every 600ms.
  const frame = await renderFanout(
    React.createElement(AgentFanout, {
      blocks: [
        agent({ toolCallId: "a", output: "⎿ Reading x\n" }),
        agent({ toolCallId: "b", output: "⎿ Writing y\n" }),
      ],
    }),
    900,
  );
  expect(frame).toContain(`${BLACK_CIRCLE} Running 2 explore agents`);
  expect(frame).toContain("  Running 2 explore agents");
});
