import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render } from "ink";

import Spinner, {
  SHOW_TOKENS_AFTER_MS,
  SPINNER_CYCLE,
  SPINNER_INTERVAL,
  formatElapsed,
  formatTokenCount,
  getDefaultCharacters,
} from "../../src/components/Spinner.js";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** Render one frame and return it with styling stripped. */
async function renderSpinner(node: React.ReactElement): Promise<string> {
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

  const app = render(node, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  app.unmount();
  app.cleanup();
  return out.replace(ANSI, "");
}

test("the working line is the verb and an ellipsis, not the working directory", async () => {
  // App passes noun={basename(workingDirectory)}; the reference's working line
  // is `effectiveVerb + '…'` and carries no directory.
  const frame = await renderSpinner(React.createElement(Spinner, { noun: "deepseek-code" }));
  expect(frame).toContain("…");
  expect(frame).not.toContain("deepseek-code");
});

test("leaves a blank line above the working row (reference marginTop)", async () => {
  const frame = await renderSpinner(React.createElement(Spinner, {}));
  const lines = frame.split("\n");
  expect(lines[0]).toBe("");
  expect(lines[1]).toContain("…");
});

test("shows no elapsed readout in the first 30 seconds", async () => {
  const frame = await renderSpinner(React.createElement(Spinner, {}));
  // Used to tick "0s" from the first second, and the readout had no parens.
  expect(frame).not.toContain("0s");
  expect(frame).not.toContain("(");
  expect(frame).not.toContain(")");
});

test("the readout carries the token counter and the thinking state", async () => {
  // Reference SpinnerAnimationRow: "(2m 5s · ↓ 1.2k tokens · thinking with
  // medium effort)" — verbose forces the timer/token pair on before 30s.
  const frame = await renderSpinner(
    React.createElement(Spinner, {
      verbose: true,
      tokens: 1200,
      thinking: true,
      effortSuffix: " with medium effort",
    }),
  );
  expect(frame).toContain("(0s · ↓ 1.2k tokens · thinking with medium effort)");
});

test("the thinking state shows before the 30s gate, the token counter does not", async () => {
  const frame = await renderSpinner(
    React.createElement(Spinner, {
      tokens: 1200,
      thinking: true,
      effortSuffix: " with medium effort",
    }),
  );
  // thinkingOnly: the state is parenthesised on its own.
  expect(frame).toContain("(thinking with medium effort)");
  expect(frame).not.toContain("tokens");
  expect(frame).not.toContain("0s");
});

test("a zero token count adds no token part", async () => {
  const frame = await renderSpinner(React.createElement(Spinner, { verbose: true, tokens: 0 }));
  expect(frame).toContain("(0s)");
  expect(frame).not.toContain("tokens");
});

test("token counts use the reference compact format", () => {
  // utils/format.ts formatNumber: compact, one fixed decimal from 1000 up.
  expect(formatTokenCount(900)).toBe("900");
  expect(formatTokenCount(1000)).toBe("1.0k");
  expect(formatTokenCount(1200)).toBe("1.2k");
  expect(formatTokenCount(1_000_000)).toBe("1.0m");
});

test("elapsed readout switches to the reference duration format", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(12_400)).toBe("12s");
  expect(formatElapsed(59_900)).toBe("59s");
  expect(formatElapsed(125_000)).toBe("2m 5s");
  expect(formatElapsed(3_600_000)).toBe("1h 0m 0s");
});

test("timing constants match the reference", () => {
  // SpinnerAnimationRow: Math.floor(time / 120)
  expect(SPINNER_INTERVAL).toBe(120);
  // SpinnerAnimationRow: SHOW_TOKENS_AFTER_MS
  expect(SHOW_TOKENS_AFTER_MS).toBe(30_000);
});

test("the glyph cycle is the full forward + reversed list", () => {
  // Reference: [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()]
  // — 12 frames, with the last glyph and '·' each held for two frames.
  expect(SPINNER_CYCLE.length).toBe(12);
  expect(SPINNER_CYCLE[5]).toBe(SPINNER_CYCLE[6]);
  expect(SPINNER_CYCLE[0]).toBe(SPINNER_CYCLE[11]);
});

test("Ghostty and non-darwin terminals substitute * for the offset glyph", () => {
  const savedTerm = process.env.TERM;
  const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const setPlatform = (value: string) =>
    Object.defineProperty(process, "platform", { value, configurable: true });
  const setTerm = (value: string | undefined) => {
    if (value === undefined) delete process.env.TERM;
    else process.env.TERM = value;
  };

  try {
    // Ghostty: the *last* frame is the offset one.
    setTerm("xterm-ghostty");
    setPlatform("darwin");
    const ghostty = getDefaultCharacters();
    expect(ghostty).toHaveLength(6);
    expect(ghostty[5]).toBe("*");

    // Other platforms: the offset glyph is ✳ instead.
    setTerm("xterm-256color");
    setPlatform("linux");
    const linux = getDefaultCharacters();
    expect(linux).toHaveLength(6);
    expect(linux[2]).toBe("*");
    expect(linux[5]).toBe("✽");

    // darwin keeps the full set.
    setPlatform("darwin");
    expect(getDefaultCharacters()[2]).toBe("✳");
    expect(getDefaultCharacters()[5]).toBe("✽");
  } finally {
    setTerm(savedTerm);
    if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
  }
});
