/**
 * The two App-level lists: command picker rows and file-mention rows. Both
 * are single-line rows, so the list is one region and the row index maps
 * straight through (the picker's top "…" marker included).
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import CommandPicker from "../../src/components/CommandPicker.js";
import FileMentions from "../../src/components/FileMentions.js";
import { visibleCommandRange } from "../../src/components/commandPickerLayout.js";
import { mountWithMouse, report, settle, write, type MountedMouseApp } from "./mouseTestHarness.js";

let apps: MountedMouseApp[] = [];
afterEach(() => {
  for (const app of apps) app.unmount();
  apps = [];
});

function mount(node: React.ReactElement): MountedMouseApp {
  const app = mountWithMouse(node);
  apps.push(app);
  return app;
}

const commands = [
  { name: "help", description: "Show help", usage: ["/help"] },
  { name: "model", description: "Pick a model", usage: ["/model "] },
  { name: "skills", description: "List skills", usage: ["/skills "] },
] as never;

describe("CommandPicker clicks", () => {
  test("a click on a row reports that command's index", async () => {
    const picked: number[] = [];
    const app = mount(
      React.createElement(CommandPicker, {
        commands,
        selectedIndex: 0,
        onPick: (i: number) => picked.push(i),
      }),
    );
    await settle();
    await write(app, report(0, 3, 2)); // second row
    await settle();
    expect(picked).toEqual([1]);
  });

  test("the top ellipsis row is not a command", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      name: `cmd${i}`,
      description: `Command ${i}`,
      usage: [`/cmd${i}`],
    })) as never;
    const picked: number[] = [];
    const app = mount(
      React.createElement(CommandPicker, {
        commands: many,
        selectedIndex: 5,
        onPick: (i: number) => picked.push(i),
      }),
    );
    await settle();
    const { start } = visibleCommandRange(8, 5, 6);
    expect(start).toBeGreaterThan(0); // the ellipsis IS showing, or this test is moot
    await write(app, report(0, 3, 1)); // the "…" row itself
    await settle();
    expect(picked).toEqual([]);
    await write(app, report(0, 3, 2)); // first real row
    await settle();
    expect(picked).toEqual([start]);
  });
});
