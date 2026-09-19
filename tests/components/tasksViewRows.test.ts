import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import React from "react";
import { render } from "ink";

// Registered tasks write their output tails under the data dir; keep them out
// of the real ~/.deepseek-code. dataDir() resolves per call, so setting this
// before any task is registered is enough.
process.env.DEEPSEEK_CODE_DATA_DIR = mkdtempSync(join(tmpdir(), "dsc-tasks-view-"));

import TasksView from "../../src/components/TasksView.js";
import {
  listTasks,
  registerVirtualTask,
  updateTaskState,
} from "../../src/services/tasks/backgroundFramework.js";

/* Rendered frame. The reference rows (tasks/BackgroundTask.tsx +
   ShellProgress.tsx) read "<description> (running|done|error|stopped)" — no
   dot glyph, no duration — and its input guide reads "<key> to <action>", with
   "x to stop" only while the focused row is running. The pre-port rows were
   "● <desc> · running · 12s" with the guide "↑↓ select · enter view · x stop ·
   esc close", so every assertion here fails against them. */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

async function renderFrame(node: React.ReactElement): Promise<string> {
  let out = "";
  // Ink needs an EventEmitter-shaped stdout and a raw-mode-capable stdin, and
  // only the parts it touches: this process has no TTY.
  const stdout = Object.assign(new EventEmitter(), {
    columns: 100,
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

  const { unmount, cleanup } = render(node, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  unmount();
  cleanup();
  return out.replace(ANSI, "");
}

const view = (): React.ReactElement => React.createElement(TasksView, { onClose: () => {} });

registerVirtualTask("shell", "npm run dev", { description: "npm run dev" });
registerVirtualTask("agent", "agent code: review the diff", { description: "review the diff" });
const doneWorkflow = registerVirtualTask("workflow", "workflow triage: nightly", {
  description: "triage run",
});
updateTaskState(doneWorkflow.id, { status: "done", endedAt: Date.now(), exitCode: 0 });

test("rows read '<description> (status)' — no dot glyph, no duration", async () => {
  const frame = await renderFrame(view());
  expect(frame).toContain("npm run dev (running)");
  expect(frame).toContain("review the diff (running)");
  expect(frame).toContain("triage run (done)");
  // The port's old row: "● npm run dev · running · 12s".
  expect(frame).not.toContain("●");
  expect(frame).not.toMatch(/· running · \d+s/);
});

test("the subtitle counts shells and agents, never workflows", async () => {
  const frame = await renderFrame(view());
  expect(frame).toContain("1 active shell · 1 active agent");
  // A running workflow is not a subtitle category upstream.
  expect(frame).not.toContain("active workflow");
});

test("the guide uses upstream's keys and verbs, and stops offering x when idle", async () => {
  const withRunning = await renderFrame(view());
  expect(withRunning).toContain("↑/↓ to select · Enter to view · x to stop · ←/Esc to close");

  // Flip every live task terminal, then mount again: the focused row is done,
  // so upstream's guide drops the stop hint.
  for (const task of listTasks()) {
    if (task.status === "running") {
      updateTaskState(task.id, { status: "done", endedAt: Date.now(), exitCode: 0 });
    }
  }
  const allDone = await renderFrame(view());
  expect(allDone).toContain("npm run dev (done)");
  expect(allDone).toContain("↑/↓ to select · Enter to view · ←/Esc to close");
  expect(allDone).not.toContain("x to stop");
  // Nothing is running, so the reference omits the subtitle entirely.
  expect(allDone).not.toContain("active shell");
  expect(allDone).not.toContain("active agent");
});
