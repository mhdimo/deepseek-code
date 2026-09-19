import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render, Text } from "ink";

import { Dialog } from "../../src/ui/design-system/Dialog.js";
import { StatusIcon } from "../../src/ui/design-system/StatusIcon.js";
import { getTheme, setThemeMode, theme } from "../../src/utils/theme.js";

/* Theme tokens, status glyphs and the dialog frame — the three shared pieces
   a wrong change here would get wrong everywhere at once. */

/** Colours are written with and without spaces around the commas. */
const flat = (color: string): string => color.replace(/\s+/g, "");

test("the dark theme's diff colours are the reference's, not the native renderer's", () => {
  const dark = getTheme("dark");
  expect(dark.diffAdded).toBe("rgb(34,92,43)");
  expect(dark.diffRemoved).toBe("rgb(122,41,54)");
  expect(dark.diffAddedWord).toBe("rgb(56,166,96)");
  expect(dark.diffRemovedWord).toBe("rgb(179,89,107)");
  // The dimmed pair already matched and must not drift.
  expect(dark.diffAddedDimmed).toBe("rgb(71,88,74)");
  expect(dark.diffRemovedDimmed).toBe("rgb(105,72,77)");
});

test("the live theme hands ToolBlock's +/- lines legible colours", () => {
  setThemeMode("dark");
  try {
    expect(theme.diffAddedWord).toBe("rgb(56,166,96)");
    expect(theme.diffRemovedWord).toBe("rgb(179,89,107)");
    expect(theme.diffAdded).toBe("rgb(34,92,43)");
    expect(theme.diffRemoved).toBe("rgb(122,41,54)");
  } finally {
    setThemeMode("dark");
  }
});

test("the light theme's permission accent is the light blue, not the dark one", () => {
  const light = getTheme("light");
  expect(light.permission).toBe("rgb(87,105,247)");
  expect(light.permissionShimmer).toBe("rgb(137,155,255)");
  // The dark theme keeps the value the light theme used to borrow.
  expect(getTheme("dark").permission).toBe("rgb(177,185,249)");
});

test("both daltonized themes override the sub-agent colours", () => {
  const lightDaltonized = getTheme("light-daltonized");
  expect(lightDaltonized.red_FOR_SUBAGENTS_ONLY).toBe("rgb(204,0,0)");
  expect(lightDaltonized.blue_FOR_SUBAGENTS_ONLY).toBe("rgb(0,102,204)");
  expect(lightDaltonized.green_FOR_SUBAGENTS_ONLY).toBe("rgb(0,204,0)");
  expect(lightDaltonized.yellow_FOR_SUBAGENTS_ONLY).toBe("rgb(255,204,0)");
  expect(lightDaltonized.purple_FOR_SUBAGENTS_ONLY).toBe("rgb(128,0,128)");
  expect(lightDaltonized.orange_FOR_SUBAGENTS_ONLY).toBe("rgb(255,128,0)");
  expect(lightDaltonized.pink_FOR_SUBAGENTS_ONLY).toBe("rgb(255,102,178)");
  expect(lightDaltonized.cyan_FOR_SUBAGENTS_ONLY).toBe("rgb(0,178,178)");
  // …and its rate-limit bar, which was inheriting the plain light palette.
  expect(lightDaltonized.rate_limit_fill).toBe("rgb(51,102,255)");
  expect(lightDaltonized.rate_limit_empty).toBe("rgb(23,46,114)");

  const darkDaltonized = getTheme("dark-daltonized");
  expect(darkDaltonized.red_FOR_SUBAGENTS_ONLY).toBe("rgb(255,102,102)");
  expect(darkDaltonized.blue_FOR_SUBAGENTS_ONLY).toBe("rgb(102,178,255)");
  expect(darkDaltonized.green_FOR_SUBAGENTS_ONLY).toBe("rgb(102,255,102)");
  expect(darkDaltonized.yellow_FOR_SUBAGENTS_ONLY).toBe("rgb(255,255,102)");
  expect(darkDaltonized.purple_FOR_SUBAGENTS_ONLY).toBe("rgb(178,102,255)");
  expect(darkDaltonized.orange_FOR_SUBAGENTS_ONLY).toBe("rgb(255,178,102)");
  expect(darkDaltonized.pink_FOR_SUBAGENTS_ONLY).toBe("rgb(255,153,204)");
  expect(darkDaltonized.cyan_FOR_SUBAGENTS_ONLY).toBe("rgb(102,204,204)");
  expect(darkDaltonized.rate_limit_empty).toBe("rgb(69,92,115)");
  expect(darkDaltonized.fastMode).toBe("rgb(255,120,20)");
  expect(darkDaltonized.fastModeShimmer).toBe("rgb(255,165,70)");
});

test("light mode keeps the light theme's grays instead of the legacy palette's", () => {
  const light = getTheme("light");
  setThemeMode("light");
  try {
    // The mutable palette wins over the theme's copy-back, so its values are
    // what a light terminal actually shows.
    expect(flat(theme.promptBorder)).toBe(light.promptBorder);
    expect(flat(theme.subtle)).toBe(light.subtle);
    expect(flat(theme.inactive)).toBe(light.inactive);
  } finally {
    setThemeMode("dark");
  }
  const dark = getTheme("dark");
  expect(flat(theme.promptBorder)).toBe(dark.promptBorder);
  expect(flat(theme.subtle)).toBe(dark.subtle);
  expect(flat(theme.inactive)).toBe(dark.inactive);
});

/* Rendered frames: the glyphs and the dialog frame are what a user sees. */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

async function renderFrame(node: React.ReactElement): Promise<string> {
  let out = "";
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 40,
    isTTY: false,
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

  const { unmount, cleanup } = render(node, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  unmount();
  cleanup();
  return out.replace(ANSI, "");
}

const glyphOf = (frame: string): number[] =>
  [...frame.replace(/\s/g, "")].map((char) => char.codePointAt(0)!);

test("status icons use figures' glyph variants", async () => {
  // figures: tick U+2714, cross U+2718, warning U+26A0, circle U+25EF.
  expect(glyphOf(await renderFrame(React.createElement(StatusIcon, { status: "success" })))).toEqual([0x2714]);
  expect(glyphOf(await renderFrame(React.createElement(StatusIcon, { status: "error" })))).toEqual([0x2718]);
  expect(glyphOf(await renderFrame(React.createElement(StatusIcon, { status: "warning" })))).toEqual([0x26a0]);
  expect(glyphOf(await renderFrame(React.createElement(StatusIcon, { status: "pending" })))).toEqual([0x25ef]);
});

test("the dialog's blank row sits above the rule, with the title under it", async () => {
  const frame = await renderFrame(
    React.createElement(Dialog, {
      title: "Pick a thing",
      onCancel: () => {},
      children: React.createElement(Text, null, "body"),
    }),
  );
  const lines = frame.split("\n");
  const ruleIndex = lines.findIndex((line) => line.includes("─"));
  const titleIndex = lines.findIndex((line) => line.includes("Pick a thing"));
  expect(ruleIndex).toBeGreaterThan(0);
  expect(lines[ruleIndex - 1]!.trim()).toBe("");
  expect(titleIndex).toBe(ruleIndex + 1);
});

test("the default dialog footer names the keys in the reference's casing", async () => {
  const frame = await renderFrame(
    React.createElement(Dialog, {
      title: "Pick a thing",
      onCancel: () => {},
      children: React.createElement(Text, null, "body"),
    }),
  );
  expect(frame).toContain("Enter to confirm · Esc to cancel");
  expect(frame).not.toContain("enter to confirm");
});
