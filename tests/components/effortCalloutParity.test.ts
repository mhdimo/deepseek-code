import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render } from "ink";

import EffortCallout from "../../src/components/EffortCallout.js";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

async function renderCallout(props: { currentLevel?: string } = {}): Promise<string> {
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
    React.createElement(EffortCallout, {
      onDone: () => {},
      currentLevel: props.currentLevel,
    } as unknown as React.ComponentProps<typeof EffortCallout>),
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

test("the dialog is a top rule with a title, not a four-sided box", async () => {
  // Reference PermissionDialog: borderLeft/Right/Bottom are false.
  const frame = await renderCallout();
  expect(frame).not.toContain("│");
  expect(frame).not.toContain("╰");
  expect(frame).not.toContain("╯");
  expect(frame).toContain("\n We recommend medium effort\n");
});

test("the symbol legend sits between the description and the options", async () => {
  const frame = await renderCallout();
  expect(frame).toContain("○ low · ◐ medium · ● high");
  const description = frame.indexOf("Effort determines how long the model thinks");
  const legend = frame.indexOf("○ low · ◐ medium · ● high");
  const options = frame.indexOf("Medium (recommended)");
  expect(description).toBeGreaterThanOrEqual(0);
  expect(legend).toBeGreaterThan(description);
  expect(options).toBeGreaterThan(legend);
});

test("the options are a vertical list, recommended tier first and Low last", async () => {
  const frame = await renderCallout();
  expect(frame).toContain(
    [
      "   ❯ ◐ Medium (recommended)",
      "     ● High",
      "     ◈ Extra high",
      "     ◉ Max",
      "     ○ Low",
    ].join("\n"),
  );
});

test("the focused row follows the current level", async () => {
  const frame = await renderCallout({ currentLevel: "high" });
  expect(frame).toContain("   ❯ ● High");
  expect(frame).not.toContain("❯ ◐ Medium (recommended)");
});

test("the body copy ends with the ultrathink sentence", async () => {
  const frame = await renderCallout();
  expect(frame).toContain("Use ultrathink to trigger high effort when needed.");
  expect(frame).not.toContain("Use high or max when you need deeper reasoning.");
});
