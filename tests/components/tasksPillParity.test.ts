import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import React from "react";
import { render } from "ink";

import TasksStatusPill from "../../src/components/TasksStatusPill.js";
import {
  registerVirtualTask,
  updateTaskState,
} from "../../src/services/tasks/backgroundFramework.js";

// Redirect the task-output store at a scratch dir (dataDir() reads this per
// call, so the env var can be set after the imports are evaluated).
process.env.DEEPSEEK_CODE_DATA_DIR = mkdtempSync(join(tmpdir(), "dsc-pill-"));

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

async function renderPill(): Promise<string> {
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

  const app = render(React.createElement(TasksStatusPill), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
  });
  // One poll tick, so the mount-time listTasks() result has been rendered.
  await new Promise((resolve) => setTimeout(resolve, 120));
  app.unmount();
  app.cleanup();
  return out.replace(ANSI, "");
}

test("the pill is the label alone — no status dot, no CTA", async () => {
  const task = registerVirtualTask("agent", "agent explore: map the architecture", { name: "explore" });
  try {
    const frame = await renderPill();
    expect(frame).toContain("1 local agent");
    // Reference SummaryPill renders the pill label with no leading dot, and
    // its " · ↓ to view" CTA belongs to the ultraplan attention states only.
    expect(frame).not.toContain("●");
    expect(frame).not.toContain("↓");
    expect(frame).not.toContain("to view");
  } finally {
    updateTaskState(task.id, { status: "done" });
  }
});

test("an idle registry renders nothing", async () => {
  const frame = await renderPill();
  expect(frame).not.toContain("local agent");
});
