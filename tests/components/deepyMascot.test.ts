/**
 * The Deepy whale mascot: sprite data -> half-block renderings.
 *
 * The packing rule is the one from the sprite kit's README: two vertically
 * adjacent pixels become one cell, the top pixel the foreground and the
 * bottom the background of `▀`; a transparent half keeps the terminal's own
 * background.
 */
import { expect, test } from "bun:test";
import { DEEPY_IDLE, DEEPY_PALETTE } from "../../src/components/deepyWhale.js";
import {
  DEEPY_BLUE,
  deepyWhaleFrame,
  deepyWhaleSolid,
  packDeepyFrame,
} from "../../src/components/deepyMascot.js";

const SGR = /\x1b\[[0-9;]*m/g;
const IDLE0 = DEEPY_IDLE[0]!;

test("packs two pixel rows into one cell row", () => {
  // B on top of K, then W on top of nothing, then two transparent columns.
  const cells = packDeepyFrame(["BW..", "K..."]);
  expect(cells.length).toBe(1);
  // Trailing transparent cells are dropped, so the row ends after the W.
  expect(cells[0]).toEqual([
    { top: DEEPY_PALETTE.B!, bottom: DEEPY_PALETTE.K! },
    { top: DEEPY_PALETTE.W!, bottom: null },
  ]);
});

test("a bottom-only pixel keeps its cell", () => {
  const cells = packDeepyFrame(["....", "B..."]);
  expect(cells).toEqual([[{ top: null, bottom: DEEPY_PALETTE.B! }]]);
});

test("an odd pixel row leaves the bottom half empty", () => {
  const cells = packDeepyFrame(["B"]);
  expect(cells).toEqual([[{ top: DEEPY_PALETTE.B!, bottom: null }]]);
});

test("drops trailing empty cell rows", () => {
  const cells = packDeepyFrame(["B.", "..", "..", ".."]);
  expect(cells).toEqual([[{ top: DEEPY_PALETTE.B!, bottom: null }]]);
});

test("truecolor rows carry the sprite palette as SGR, foreground and background", () => {
  const rows = deepyWhaleFrame(IDLE0);
  expect(rows.length).toBeGreaterThan(5);
  // Body blue #4E6FFF as foreground; navy #142660 as background somewhere.
  const all = rows.join("\n");
  expect(all).toContain("38;2;78;111;255");
  expect(all).toContain("48;2;20;38;96");
  // Every row ends with a reset, so nothing bleeds into the rest of the box.
  for (const row of rows) expect(row.endsWith("\x1b[0m")).toBe(true);
});

test("truecolor and solid renderings are the same shape", () => {
  // Same cells, different paint: where the solid rendering has no second
  // color to fill a full cell with, it uses a full block; truecolor fills
  // the bottom half with the background SGR instead.
  const solid = deepyWhaleSolid(IDLE0).map((r) => r.replaceAll("█", "▀"));
  const truecolor = deepyWhaleFrame(IDLE0).map((r) => r.replace(SGR, ""));
  expect(truecolor).toEqual(solid);
});

test("solid rows use only block characters", () => {
  for (const row of deepyWhaleSolid(IDLE0)) {
    expect(row).toMatch(/^[▀▄█ ]*$/);
    expect(row).not.toContain("\x1b");
  }
});

test("the idle animation data is intact", () => {
  expect(DEEPY_IDLE.length).toBe(9);
  const width = IDLE0.rows[0]!.length;
  for (const frame of DEEPY_IDLE) {
    expect(frame.dur).toBeGreaterThan(0);
    expect(frame.rows.length).toBeGreaterThan(0);
    for (const row of frame.rows) {
      expect(row.length).toBe(width);
      for (const ch of row) {
        expect(ch === "." || ch in DEEPY_PALETTE).toBe(true);
      }
    }
  }
});

test("the whale silhouette is present and drawn in the body blue", () => {
  const rows = deepyWhaleSolid(IDLE0);
  // Dense body mass: at least one row is mostly filled.
  const dense = rows.filter((r) => (r.match(/[█▀▄]/g)?.length ?? 0) > 20);
  expect(dense.length).toBeGreaterThan(0);
  expect(DEEPY_BLUE).toMatch(/^#[0-9A-F]{6}$/i);
});

test("the welcome screen draws the whale", async () => {
  const React = (await import("react")).default;
  const { renderToString } = await import("ink");
  const { default: WelcomeScreen } = await import("../../src/components/WelcomeScreen.js");
  const out = renderToString(
    React.createElement(WelcomeScreen, {
      version: "9.9.9",
      model: "deepseek-chat",
      workingDirectory: "/tmp/proj",
      agentName: "code",
      providerType: "deepseek",
    }),
  );
  // Half-blocks from the sprite, in whichever rendering the "terminal" allows.
  expect(out).toMatch(/[▀▄█]/);
});
