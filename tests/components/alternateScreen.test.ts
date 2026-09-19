import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render } from "ink";

import AlternateScreen from "../../src/components/AlternateScreen.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const CLEAR_AND_HOME = "\x1b[2J\x1b[H";

const MARKER = "alternate-screen-marker";

/**
 * Both writers land in one buffer, in the order the terminal sees them.
 *
 * The component writes to `process.stdout` directly (it is a terminal-mode
 * switch, not a frame, so it has no business going through the renderer),
 * while ink writes frames to whatever stream it was handed. Pointing both at
 * the same buffer is the only way to assert the thing that actually matters
 * here: that the enter sequence reaches the terminal *before* the first frame
 * does. With a layout effect it would arrive after, and the frame already
 * written to the main screen would be preserved underneath the alt screen and
 * revealed as a broken view on exit.
 */
function captureStreams() {
  let out = "";
  const write = (chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };

  const stdout = Object.assign(new EventEmitter(), {
    columns: 120,
    rows: 40,
    isTTY: true,
    write,
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

  const realWrite = process.stdout.write;
  (process.stdout as unknown as { write: unknown }).write = write;

  return {
    stdout,
    stdin,
    text: () => out,
    restore: () => {
      (process.stdout as unknown as { write: unknown }).write = realWrite;
    },
  };
}

async function renderAlt(): Promise<{
  text: () => string;
  unmount: () => void;
  restore: () => void;
  exitListenersBefore: number;
}> {
  const capture = captureStreams();
  const exitListenersBefore = process.listenerCount("exit");

  const app = render(
    React.createElement(
      AlternateScreen,
      null,
      React.createElement("ink-text", null, MARKER),
    ),
    {
      stdout: capture.stdout,
      stdin: capture.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: false,
    },
  );

  // One tick, so the first frame has been committed and written.
  await new Promise((resolve) => setTimeout(resolve, 120));

  return {
    text: capture.text,
    unmount: () => {
      app.unmount();
      app.cleanup();
    },
    restore: capture.restore,
    exitListenersBefore,
  };
}

test("the alt screen is entered before the first frame is drawn", async () => {
  const app = await renderAlt();
  try {
    const out = app.text();
    expect(out.startsWith(ENTER_ALT_SCREEN + CLEAR_AND_HOME)).toBe(true);
    // The frame exists — otherwise "startsWith" would be trivially true — and
    // it landed after the switch.
    expect(out).toContain(MARKER);
    expect(out.indexOf(MARKER)).toBeGreaterThan(out.indexOf(ENTER_ALT_SCREEN));
  } finally {
    app.unmount();
    app.restore();
  }
});

test("leaving writes the leave sequence and drops the exit handler", async () => {
  const app = await renderAlt();
  const before = app.exitListenersBefore;
  try {
    expect(process.listenerCount("exit")).toBe(before + 1);
    app.unmount();
    const out = app.text();
    expect(out).toContain(LEAVE_ALT_SCREEN);
    // After the frame, not before it: the screen is given back last.
    expect(out.lastIndexOf(LEAVE_ALT_SCREEN)).toBeGreaterThan(out.indexOf(MARKER));
    // The handler is registered for the lifetime of the mount only. A leaked
    // one would write the leave sequence again on a later, unrelated exit.
    expect(process.listenerCount("exit")).toBe(before);
  } finally {
    app.restore();
  }
});

test("a process exit that never unmounts still leaves the alt screen", async () => {
  const app = await renderAlt();
  try {
    // Kill the process out from under the tree — a SIGINT that skips React's
    // unmount path. Without the exit handler the terminal is left in the alt
    // screen and the user's shell comes back to a blank window.
    const listeners = process.listeners("exit");
    expect(listeners.length).toBeGreaterThan(0);
    (listeners[listeners.length - 1] as () => void)();
    expect(app.text()).toContain(LEAVE_ALT_SCREEN);
  } finally {
    app.unmount();
    app.restore();
  }
});
