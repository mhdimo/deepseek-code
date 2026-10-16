/**
 * Clicking the prompt places the caret where you clicked — including in the
 * middle of a wrapped line — and typing continues from there.
 *
 * The layout is fixed by the test (a 120-column "terminal", a 2-cell "❯ "
 * prefix) so every expected offset is arithmetic a reader can redo by hand.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { Box, Text } from "ink";
import MultilineTextInput from "../../src/components/MultilineTextInput.js";
import { mountWithMouse, report, settle, write, type MountedMouseApp } from "./mouseTestHarness.js";

let apps: MountedMouseApp[] = [];
afterEach(() => {
  for (const app of apps) app.unmount();
  apps = [];
});

/** MTLTI behind a "❯ " prefix in a row Box — the real TextInput shape:
 *  text cells start at column 2 (0-based), so region col = screen col - 3
 *  for 1-based SGR columns. */
function prompt(initial: string, onValue?: (v: string) => void) {
  let latest = initial;
  function Wrap() {
    const [value, setValue] = React.useState(initial);
    latest = value;
    return React.createElement(
      Box,
      { flexDirection: "row", width: 120 },
      React.createElement(Text, null, "❯ "),
      React.createElement(MultilineTextInput, {
        value,
        onChange: (next: string) => {
          setValue(next);
          onValue?.(next);
        },
        onSubmit: () => {},
        focus: true,
      }),
    );
  }
  return { node: React.createElement(Wrap), value: () => latest };
}

function mount(node: React.ReactElement): MountedMouseApp {
  const app = mountWithMouse(node);
  apps.push(app);
  return app;
}

describe("clicking the prompt", () => {
  test("click mid-word puts the caret mid-word; typing continues there", async () => {
    const p = prompt("abcdef");
    const app = mount(p.node);
    await settle();
    // SGR col 6 (1-based) = 0-based col 5 = region col 3 = index 3 in "abcdef".
    await write(app, report(0, 6, 1));
    await settle();
    await write(app, "X");
    await settle();
    expect(p.value()).toBe("abcXdef");
  });

  test("a click on a wrapped continuation row lands on that row's cell", async () => {
    // 130 chars at region width 118: row 1 (0-based) is the second visual row.
    // SGR row 2, col 5 → screen col 4 → region col 2 (the "❯ " prefix takes
    // the first two cells of the row) → offset 118 + 2 = 120.
    const value = "a".repeat(125) + "bcdef";
    const p = prompt(value);
    const app = mount(p.node);
    await settle();
    await write(app, report(0, 5, 2));
    await settle();
    await write(app, "X");
    await settle();
    expect(p.value()).toBe("a".repeat(120) + "X" + "a".repeat(5) + "bcdef");
  });

  test("a click past the end of a line clamps to the line's end", async () => {
    const p = prompt("abc");
    const app = mount(p.node);
    await settle();
    await write(app, report(0, 60, 1));
    await settle();
    await write(app, "X");
    await settle();
    expect(p.value()).toBe("abcX");
  });

  test("a click when the prompt is empty leaves the caret at the start", async () => {
    const p = prompt("");
    const app = mount(p.node);
    await settle();
    await write(app, report(0, 10, 1));
    await settle();
    await write(app, "hi");
    await settle();
    expect(p.value()).toBe("hi");
  });

  test("nothing is typed by the click itself", async () => {
    const p = prompt("abc");
    const app = mount(p.node);
    await settle();
    await write(app, report(0, 6, 1) + report(0, 6, 1, "m"));
    await settle();
    expect(p.value()).toBe("abc"); // unchanged: the report never became text
  });
});
