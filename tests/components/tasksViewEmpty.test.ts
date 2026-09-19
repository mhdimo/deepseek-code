import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import React from "react";
import { render } from "ink";

// Its own process (bun test --isolate) so the task registry is genuinely empty.
process.env.DEEPSEEK_CODE_DATA_DIR = mkdtempSync(join(tmpdir(), "dsc-tasks-empty-"));

import TasksView from "../../src/components/TasksView.js";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

async function renderFrame(node: React.ReactElement): Promise<string> {
  let out = "";
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

test("no tasks: the empty state and the reference's guide", async () => {
  const frame = await renderFrame(React.createElement(TasksView, { onClose: () => {} }));
  expect(frame).toContain("Background tasks");
  expect(frame).toContain("No tasks currently running");
  // Upstream's guide is the same list with nothing running: no stop hint, and
  // the close key reads "←/Esc", not the port's bare "esc".
  expect(frame).toContain("↑/↓ to select · Enter to view · ←/Esc to close");
  expect(frame).not.toContain("x to stop");
});
