/**
 * The dispatcher contract: an intercepted press is swallowed whole (no
 * selection anchor, no drag, no release copy), and everything else — wheel,
 * unclaimed presses, releases — behaves exactly as before.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { Box, Text } from "ink";
import { ClickRegionBox } from "../../src/components/mouseRegions.js";
import { mountWithMouse, report, settle, write, type MountedMouseApp } from "./mouseTestHarness.js";

let apps: MountedMouseApp[] = [];
afterEach(() => {
  for (const app of apps) app.unmount();
  apps = [];
});

function twoRowChat(): Partial<import("../../src/components/ChatPanel.js").ChatPanelHandle> {
  return {
    getViewport: () => ({ topOffset: 0, scrollTop: 0, totalRows: 2, width: 100 }),
    getRowAt: () => ({ text: "hello world", origin: 0 }),
    copySelection: () => "hello world",
  } as never;
}

function mount(node: React.ReactElement, chat = twoRowChat()): MountedMouseApp {
  const app = mountWithMouse(node, { chat });
  apps.push(app);
  return app;
}

const plainContent = React.createElement(
  Box,
  null,
  React.createElement(Text, null, "hello world"),
);

describe("intercept arbitration", () => {
  test("a claimed press is swallowed: no selection anchor, no drag, no copy", async () => {
    const seen: Array<[number, number, number, number]> = [];
    function Claimed() {
      return React.createElement(
        ClickRegionBox,
        {
          onClickRegion: (ev: { row: number; col: number; clickCount: number; button: number }) =>
            seen.push([ev.row, ev.col, ev.clickCount, ev.button]),
        },
        React.createElement(Text, null, "hello world"),
      );
    }
    const app = mount(React.createElement(Claimed));
    await write(app, report(0, 1, 1)); // press inside the region
    await write(app, report(32, 3, 1)); // drag
    await write(app, report(3, 3, 1)); // release
    await settle();
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual([0, 0, 1, 0]);
    expect(app.selections.length).toBe(0); // nothing anchored anywhere
  });

  test("an unclaimed press still anchors a transcript selection", async () => {
    const app = mount(plainContent); // no regions mounted at all
    await write(app, report(0, 5, 1));
    await settle();
    expect(app.selections.length).toBe(1);
    expect(app.selections[0]).toMatchObject({ startRow: 0, startCol: 4 });
  });

  test("double-press in the same cell is offered with clickCount 2", async () => {
    const counts: number[] = [];
    function Claimed() {
      return React.createElement(
        ClickRegionBox,
        {
          onClickRegion: (ev: { clickCount: number }) => counts.push(ev.clickCount),
        },
        React.createElement(Text, null, "x"),
      );
    }
    const app = mount(React.createElement(Claimed));
    await write(app, report(0, 1, 1));
    await write(app, report(3, 1, 1));
    await write(app, report(0, 1, 1));
    await settle();
    expect(counts).toEqual([1, 2]);
  });

  test("right press is offered with button 2; releases and wheels are not", async () => {
    const buttons: number[] = [];
    function Claimed() {
      return React.createElement(
        ClickRegionBox,
        {
          onClickRegion: (ev: { button: number }) => buttons.push(ev.button),
        },
        React.createElement(Text, null, "x"),
      );
    }
    const app = mount(React.createElement(Claimed));
    await write(app, report(2, 1, 1)); // right press
    await write(app, report(2, 1, 1, "m")); // SGR release of the right button
    await write(app, report(3, 1, 1)); // legacy release encoding
    await write(app, report(64, 5, 1)); // wheel notch
    await write(app, report(32, 2, 1)); // bare drag
    await settle();
    expect(buttons).toEqual([2]);
  });

  test("a press outside every region falls through untouched", async () => {
    function Claimed() {
      return React.createElement(
        ClickRegionBox,
        {
          onClickRegion: () => {},
          // ink's root is a column with stretch alignment, so a bare Box
          // fills the terminal width — pin it to its content so col 90 has
          // somewhere outside to be.
          width: 1,
        },
        React.createElement(Text, null, "x"),
      );
    }
    const app = mount(React.createElement(Claimed));
    await write(app, report(0, 90, 1)); // right of the region
    await settle();
    expect(app.selections.length).toBe(1); // the transcript got it instead
  });
});
