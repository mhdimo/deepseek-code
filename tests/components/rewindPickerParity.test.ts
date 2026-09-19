/**
 * /rewind against Claude Code's MessageSelector.
 *
 * The reference is headed just "Rewind" on both stages — the heading does not
 * change with the screen (MessageSelector.tsx:317-320). Its first screen
 * carries the instruction "Restore the code and/or conversation to the point
 * before…" in the body (:354) and closes with the dim italic "Enter to
 * continue · Esc to exit" (:395). Its confirm screen opens with the
 * unconditional heading "Confirm you want to restore […] to the point before
 * you sent this message:" (:329-333) — only the "the conversation" fragment
 * turns on there being a snapshot — and gates the "⚠ Rewinding does not affect
 * files edited manually or via bash." line (:345-350) on that same snapshot,
 * drawn dim. The port used to head the confirm stage "Rewind to message #N",
 * explain itself with a "Choose what to restore" subtitle, and draw the
 * warning in the warning colour for every message.
 *
 * Line numbers cite the reference build artifact, as elsewhere in tests/.
 */
import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";

import RewindPicker from "../../src/components/RewindPicker.js";
import { settleFor } from "../helpers/inkFrames.js";
import { snapshotFiles } from "../../src/utils/fileHistory.js";
import type { Message } from "../../src/types/index.js";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;
const DOWN = "\x1b[B";
const ENTER = "\r";

const MESSAGES: Message[] = [
  { role: "user", content: "first question — nothing snapshotted" },
  { role: "assistant", content: "an answer" },
  { role: "user", content: "second question — snapshotted" },
];

interface Frame {
  /** The frame as it stands, ANSI stripped. */
  out: () => string;
  send: (chunk: string) => Promise<void>;
  close: () => void;
}

async function open(workingDirectory: string, messages: Message[] = MESSAGES): Promise<Frame> {
  let out = "";
  // Poll for the frame to settle rather than sleeping a fixed 60ms: the keys
  // below are written to a fake stdin and the assertions read back what ink
  // has written, which under load has not always happened by the time a sleep
  // elapsed. See tests/helpers/inkFrames.ts.
  const settle = settleFor(() => out);
  const queue: string[] = [];
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
    read: () => (queue.length > 0 ? queue.shift()! : null),
  }) as unknown as NodeJS.ReadStream;
  (stdin as unknown as { send: (chunk: string) => void }).send = (chunk: string) => {
    queue.push(chunk);
    stdin.emit("readable");
  };

  const { unmount, cleanup } = render(
    React.createElement(RewindPicker, {
      messages,
      workingDirectory,
      onRewind: () => {},
      onClose: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, incrementalRendering: false },
  );
  await settle();

  return {
    out: () => out.replace(ANSI, ""),
    send: async (chunk: string) => {
      (stdin as unknown as { send: (chunk: string) => void }).send(chunk);
      await settle();
    },
    close: () => {
      unmount();
      cleanup();
    },
  };
}


/** A temp data dir (snapshot store) and a temp working directory. */
function sandbox(): { dataDir: string; workDir: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dsc-rewind-"));
  const previous = process.env.DEEPSEEK_CODE_DATA_DIR;
  process.env.DEEPSEEK_CODE_DATA_DIR = join(root, "data");
  const workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  return {
    dataDir: root,
    workDir,
    dispose: () => {
      if (previous === undefined) delete process.env.DEEPSEEK_CODE_DATA_DIR;
      else process.env.DEEPSEEK_CODE_DATA_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the pick list is headed 'Rewind' with the restore instruction in the body", async () => {
  const box = sandbox();
  const frame = await open(box.workDir);
  try {
    expect(frame.out()).toContain("Rewind");
    expect(frame.out()).toContain("Restore the code and/or conversation to the point before…");
    expect(frame.out()).not.toContain("Rewind conversation");
    expect(frame.out()).not.toContain("Choose a past message");
  } finally {
    frame.close();
    box.dispose();
  }
});

test("the pick list closes with the reference's Enter/Esc exit guide", async () => {
  const box = sandbox();
  const frame = await open(box.workDir);
  try {
    expect(frame.out()).toContain("Enter to continue · Esc to exit");
    expect(frame.out()).not.toContain("to choose · enter to select");
    expect(frame.out()).not.toContain("esc to cancel");
  } finally {
    frame.close();
    box.dispose();
  }
});

test("one user message is still something to rewind to", async () => {
  const box = sandbox();
  const frame = await open(box.workDir, [{ role: "user", content: "only question" }]);
  try {
    // The reference appends a virtual current-prompt entry to its option list
    // before testing it (MessageSelector.tsx:59-67), so `hasMessagesToSelect =
    // messageOptions.length > 1` (:71) holds for a single real message and the
    // pick list still renders with its Enter guide.
    expect(frame.out()).toContain("Restore the code and/or conversation to the point before…");
    expect(frame.out()).toContain("Enter to continue · Esc to exit");
  } finally {
    frame.close();
    box.dispose();
  }
});

test("the confirm screen keeps the reference's unconditional heading", async () => {
  const box = sandbox();
  const frame = await open(box.workDir);
  try {
    await frame.send(ENTER);
    expect(frame.out()).toContain("Confirm you want to restore");
    expect(frame.out()).not.toContain("Rewind to message #");
  } finally {
    frame.close();
    box.dispose();
  }
});

test("the warning shows — dim — when the chosen message has a snapshot", async () => {
  const box = sandbox();
  const tracked = join(box.workDir, "tracked.ts");
  writeFileSync(tracked, "export const a = 1;\n");
  // Message #3 is the last selectable one, so it is focused when the list opens.
  await snapshotFiles(3, [tracked], box.workDir);

  const frame = await open(box.workDir);
  try {
    await frame.send(ENTER);
    expect(frame.out()).toContain("Confirm you want to restore to the point before you sent this message:");
    expect(frame.out()).toContain("⚠ Rewinding does not affect files edited manually or via bash.");
  } finally {
    frame.close();
    box.dispose();
  }
});

test("the warning is absent for a message with no snapshot", async () => {
  const box = sandbox();
  const tracked = join(box.workDir, "tracked.ts");
  writeFileSync(tracked, "export const a = 1;\n");
  await snapshotFiles(3, [tracked], box.workDir);

  const frame = await open(box.workDir);
  try {
    // Focus moves off #3 (snapshotted) and wraps onto #1 (not snapshotted).
    await frame.send(DOWN);
    await frame.send(ENTER);
    expect(frame.out()).toContain("Confirm you want to restore the conversation to the point before you sent this message:");
    expect(frame.out()).not.toContain("Rewinding does not affect files edited");
  } finally {
    frame.close();
    box.dispose();
  }
});
