/**
 * /resume against Claude Code's LogSelector and SessionPreview.
 *
 * Three divergences, all user-visible on the session screens:
 *
 *  - the heading. The reference titles the list "Resume Session" and, when the
 *    list is longer than the window, appends a dim " (focused index of total)"
 *    counter to the heading; the port read "Resume a session" and did its
 *    paging maths in the "and N more…" row under the list.
 *  - the key guide. The reference's list footer is "Ctrl+A to show all
 *    projects · Ctrl+V to preview · Ctrl+R to rename · Type to search · Esc to
 *    cancel" — Enter resumes, Ctrl+V previews; the port advertised Enter for
 *    the preview and lower-cased every key name.
 *  - the preview. The reference puts the age/count line (always plural
 *    "messages", plus the branch when known) *under* the transcript and foots
 *    the screen "Enter to resume · Esc to cancel"; the port showed it in the
 *    dialog subtitle above the transcript, singularised the count and footed
 *    it "esc back to list".
 */
import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render, renderToString } from "ink";

import SessionPicker from "../../src/components/SessionPicker.js";
import type { SessionData } from "../../src/state/storage.js";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;
const ENTER = "\r";
const CTRL_V = "\x16";

const CWD = "/tmp/parity-sessions";

function session(index: number, overrides: Partial<SessionData> = {}): SessionData {
  return {
    hash: `hash-${index}`,
    messages: [
      { role: "user", content: `prompt number ${index}` },
      { role: "assistant", content: `answer number ${index}` },
    ],
    tokenUsage: 0,
    model: "deepseek-chat",
    agent: "code",
    workingDirectory: CWD,
    createdAt: Date.now() - index * 3600_000,
    updatedAt: Date.now() - index * 3600_000,
    ...overrides,
  };
}

interface Frame {
  out: () => string;
  send: (chunk: string) => Promise<void>;
  close: () => void;
}

async function open(
  sessions: SessionData[],
  onResume: (session: SessionData) => void = () => {},
): Promise<Frame> {
  let out = "";
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
  const send = (chunk: string) => {
    queue.push(chunk);
    stdin.emit("readable");
  };

  const { unmount, cleanup } = render(
    React.createElement(SessionPicker, {
      sessions,
      currentDirectory: CWD,
      onResume,
      onClose: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, incrementalRendering: false },
  );
  await settle();

  return {
    out: () => out.replace(ANSI, ""),
    send: async (chunk: string) => {
      send(chunk);
      await settle();
    },
    close: () => {
      unmount();
      cleanup();
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

function staticFrame(sessions: SessionData[], columns = 120): string {
  return renderToString(
    React.createElement(SessionPicker, {
      sessions,
      currentDirectory: CWD,
      onResume: () => {},
      onClose: () => {},
    }),
    { columns },
  ).replace(ANSI, "");
}

test("the list is headed 'Resume Session' with a counter when it pages", () => {
  const out = staticFrame(Array.from({ length: 12 }, (_, i) => session(i)));

  expect(out).toContain("Resume Session (1 of 12)");
  expect(out).not.toContain("Resume a session");
});

test("a list that fits carries no counter", () => {
  const out = staticFrame(Array.from({ length: 4 }, (_, i) => session(i)));

  expect(out).toContain("Resume Session");
  expect(out).not.toContain("(1 of 4)");
});

test("the list foots with the reference's guide: Ctrl+V previews, Enter resumes", async () => {
  const frame = await open(Array.from({ length: 3 }, (_, i) => session(i)));
  try {
    expect(frame.out()).toContain(
      "Ctrl+A to show all projects · Ctrl+V to preview · Ctrl+R to rename · Type to search · Esc to cancel",
    );
    // The port's own guide, with Enter on the preview and lower-case key names.
    expect(frame.out()).not.toContain("↑↓ navigate");
    expect(frame.out()).not.toContain("enter preview");
    expect(frame.out()).not.toContain("ctrl+r rename");
    expect(frame.out()).not.toContain("esc dismiss");
  } finally {
    frame.close();
  }
});

test("Ctrl+V opens the preview; the age/count line sits under the transcript", async () => {
  const frame = await open([
    session(1, {
      messages: [{ role: "user", content: "only prompt" }],
      branch: "feature/parity",
      updatedAt: Date.now(),
    }),
  ]);
  try {
    await frame.send(CTRL_V);
    const out = frame.out();

    // Under the transcript, not in the subtitle above it.
    expect(out.indexOf("only prompt")).toBeGreaterThan(-1);
    const meta = out.indexOf("just now");
    expect(meta).toBeGreaterThan(out.indexOf("only prompt"));
    // Always plural, and the branch is carried when known.
    expect(out).toContain("1 messages");
    expect(out).toContain("feature/parity");
    // Reference SessionPreview's own footer.
    expect(out).toContain("Enter to resume · Esc to cancel");
    expect(out).not.toContain("esc back to list");
  } finally {
    frame.close();
  }
});

test("Enter resumes the focused session from the list", async () => {
  const resumed: string[] = [];
  const frame = await open(
    Array.from({ length: 3 }, (_, i) => session(i)),
    (picked) => resumed.push(picked.hash),
  );
  try {
    await frame.send(ENTER);
    expect(resumed).toEqual(["hash-0"]);
  } finally {
    frame.close();
  }
});
