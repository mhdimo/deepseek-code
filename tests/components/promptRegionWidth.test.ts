/**
 * The prompt text must render at exactly the width its click region reports.
 *
 * A flex child that sets only `flexGrow` keeps its content-based flexBasis and
 * is then shrunk fractionally: in a 120-column terminal the prompt's root Box
 * computed to 118 — the width the click region reports — while the ink text
 * node inside it landed on 119. ink wraps text at the TEXT node's width; the
 * click layer maps clicks with the REGION's width. On a wrapped draft the two
 * grids drifted a cell apart (continuation-row clicks landed one character
 * off) and the first rendered row overflowed to 121 cells, corrupting the
 * frame. `flexBasis={0}` on the root Box pins layout and rendering together.
 *
 * The invariant is checked twice: on the live yoga numbers (region rect vs
 * every descendant width — no ANSI parsing, no rendering) and on the frame the
 * terminal actually receives.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { Box, Text, type DOMElement } from "ink";
import MultilineTextInput from "../../src/components/MultilineTextInput.js";
import { elementRect } from "../../src/components/mouseRegions.js";
import { mountWithMouse, settle, type MountedMouseApp } from "./mouseTestHarness.js";

let apps: MountedMouseApp[] = [];
afterEach(() => {
  for (const app of apps) app.unmount();
  apps = [];
});

/** MTLTI behind a "❯ " prefix in a row Box — the real TextInput shape: a
 *  120-column terminal minus the 2-cell prefix leaves the input 118 columns. */
function prompt(initial: string): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: "row", width: 120 },
    React.createElement(Text, null, "❯ "),
    React.createElement(MultilineTextInput, {
      value: initial,
      onChange: () => {},
      onSubmit: () => {},
      focus: true,
    }),
  );
}

function mount(node: React.ReactElement): MountedMouseApp {
  const app = mountWithMouse(node);
  apps.push(app);
  return app;
}

/** Computed widths of a laid-out subtree — the numbers yoga gave the renderer. */
function subtreeWidths(el: DOMElement | null, out: number[] = []): number[] {
  if (!el) return out;
  const width = el.yogaNode?.getComputedWidth();
  if (typeof width === "number" && Number.isFinite(width)) out.push(width);
  for (const child of el.childNodes ?? []) subtreeWidths(child as DOMElement, out);
  return out;
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

/** The rows of the most recent frame in the harness's accumulated output.
 *  ink writes each frame between synchronized-update markers; the marker is
 *  stripped along with every other escape sequence, and a stream without the
 *  marker (all of it is one frame) parses the same way. */
function lastFrameRows(raw: string): string[] {
  const last = raw.split("\x1b[?2026h").at(-1) ?? "";
  return last.replace(ANSI, "").replace(/\n+$/, "").split("\n");
}

describe("the prompt renders at its click region's width", () => {
  test("every laid-out node in the text subtree is exactly the region's width", async () => {
    const app = mount(prompt("a".repeat(300))); // a draft long enough to wrap
    await settle();

    const regions = [...app.registry.regions.values()];
    expect(regions).toHaveLength(1); // MultilineTextInput registers exactly one

    const rect = elementRect(regions[0]!.ref.current);
    expect(rect).toBeDefined();
    expect(rect!.width).toBe(118); // 120 columns - the 2-cell "❯ " prefix

    // Pre-fix the text node computed to 119: the region said 118, so the click
    // grid and the wrap grid disagreed on every continuation row.
    expect(Math.max(...subtreeWidths(regions[0]!.ref.current))).toBe(rect!.width);
  });

  test("no rendered frame row exceeds the terminal's 120 columns", async () => {
    const app = mount(prompt("a".repeat(300)));
    await settle();

    const rows = lastFrameRows(app.frame());
    // Pre-fix the first row was "❯ " + a 119-wide text node = 121 cells.
    expect(rows[0]!.length).toBe(120);
    expect(Math.max(...rows.map((row) => row.length))).toBe(120);
  });
});
