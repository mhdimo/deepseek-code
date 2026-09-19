/**
 * /skills against Claude Code's SkillsMenu.
 *
 * The reference subtitles the dialog with the entry count — `${n} ${plural(n,
 * "skill")}`, i.e. "12 skills" — where the port printed a sentence about search
 * precedence ("12 available · project > user > bundled precedence"). Its rows
 * are the skill name plus a dim " · ~1.2k description tokens" suffix and
 * nothing else; the port added a " 3. " index column and a ✓ tick beside the
 * ❯ pointer.
 */
import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render, renderToString } from "ink";

import SkillsMenu from "../../src/components/SkillsMenu.js";
import { listSkills } from "../../src/skills/skillService.js";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;
const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";

interface Frame {
  out: () => string;
  send: (chunk: string) => Promise<void>;
  close: () => void;
}

async function open(): Promise<Frame> {
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

  const { unmount, cleanup } = render(React.createElement(SkillsMenu, { onClose: () => {} }), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
  });
  await settle();

  return {
    out: () => out.replace(ANSI, ""),
    send: async (chunk: string) => {
      queue.push(chunk);
      stdin.emit("readable");
      await settle();
    },
    close: () => {
      unmount();
      cleanup();
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

test("the dialog subtitle is the skill count, not a precedence note", () => {
  const count = listSkills().length;
  expect(count).toBeGreaterThan(0); // the bundled skills ship with the repo

  const out = renderToString(React.createElement(SkillsMenu, { onClose: () => {} }), {
    columns: 120,
  }).replace(ANSI, "");

  expect(out).toContain(`${count} ${count === 1 ? "skill" : "skills"}`);
  expect(out).not.toContain("project > user > bundled precedence");
  expect(out).not.toContain("available ·");
});

test("rows are the name plus the dim token suffix — no index column, no tick", () => {
  const out = renderToString(React.createElement(SkillsMenu, { onClose: () => {} }), {
    columns: 120,
  }).replace(ANSI, "");

  const rows = out.split("\n").filter((line) => line.includes("description tokens"));
  expect(rows.length).toBeGreaterThan(0); // one window's worth of rows
  for (const row of rows) {
    // The port numbered every row ("❯ 1. code-review · ~120 description tokens").
    expect(row).not.toMatch(/\d+\.\s/);
    expect(row).not.toContain("✓");
  }
});

test("a skill that has been read carries no ✓ once the focus moves off it", async () => {
  const frame = await open();
  try {
    await frame.send(ENTER); // open the focused skill's body
    await frame.send(ESCAPE); // back to the list
    await frame.send(DOWN); // the ✓ would draw here, on the now-unfocused row
    expect(frame.out()).toContain("description tokens");
    expect(frame.out()).not.toContain("✓");
  } finally {
    frame.close();
  }
});
