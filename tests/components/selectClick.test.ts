/**
 * Clicking a Select row activates it exactly like Enter: focus moves, the
 * confirmed tick follows, and onChange fires with that option's value.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import Select from "../../src/ui/design-system/Select.js";
import { mountWithMouse, report, settle, write, type MountedMouseApp } from "./mouseTestHarness.js";

let apps: MountedMouseApp[] = [];
afterEach(() => {
  for (const app of apps) app.unmount();
  apps = [];
});

const options = [
  { label: "first", value: "a" },
  { label: "second", value: "b" },
  { label: "third", value: "c" },
];

function mount(node: React.ReactElement): MountedMouseApp {
  const app = mountWithMouse(node);
  apps.push(app);
  return app;
}

describe("Select rows", () => {
  test("a click activates that row", async () => {
    const picked: string[] = [];
    const app = mount(
      React.createElement(Select, {
        options,
        onChange: (v: string) => picked.push(v),
        onCancel: () => {},
      }),
    );
    await settle();
    // Rows are one screen line each at column 0: SGR row 2 = the second row.
    await write(app, report(0, 3, 2));
    await settle();
    expect(picked).toEqual(["b"]);
  });

  test("a click on a disabled row does nothing", async () => {
    const picked: string[] = [];
    const app = mount(
      React.createElement(Select, {
        options: [options[0]!, { ...options[1]!, disabled: true }, options[2]!],
        onChange: (v: string) => picked.push(v),
        onCancel: () => {},
      }),
    );
    await settle();
    await write(app, report(0, 3, 2));
    await settle();
    expect(picked).toEqual([]);
  });

  test("keysActive=false disables clicks too (a filter input owns the list)", async () => {
    const picked: string[] = [];
    const app = mount(
      React.createElement(Select, {
        options,
        onChange: (v: string) => picked.push(v),
        onCancel: () => {},
        keysActive: false,
      }),
    );
    await settle();
    await write(app, report(0, 3, 2));
    await settle();
    expect(picked).toEqual([]);
  });
});
