/**
 * The Config panel's search row, its hint line and the pickers its managed
 * rows open — the three places a key press lands somewhere else than in the
 * reference.
 *
 * The panel is driven through a real Ink app with recorded keystrokes: the
 * search row's caret is a *style*, the picker is a *state*, and neither is
 * visible in a static render of the initial frame. Every assertion below fails
 * against the panel as it was before the port: the caret sat on a blank glyph,
 * the query came back quoted, the hint line named different keys, and Space on
 * the Theme row cycled the value in place instead of opening the picker.
 *
 * Home and the data dir are redirected before the imports, as in
 * settingsConfigPanel.test.ts — the panel reads the user's settings file.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "node:stream";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-config-parity-"));
const home = join(sandbox, "home");
const dataDir = join(sandbox, "data");
mkdirSync(home, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const savedHome = process.env.HOME;
const savedDataDir = process.env.DEEPSEEK_CODE_DATA_DIR;
process.env.HOME = home;
process.env.DEEPSEEK_CODE_DATA_DIR = dataDir;

// The caret, the dim prefix and the focused border are only observable if the
// renderer emits their SGR codes at all. Set before ink is imported so its
// chalk picks the level up; with --isolate this reaches this file only.
const chalk = (await import("chalk")).default;
chalk.level = 3;

const React = (await import("react")).default;
const { render } = await import("ink");
const { default: Config } = await import("../../src/components/Settings/Config");

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedDataDir === undefined) delete process.env.DEEPSEEK_CODE_DATA_DIR;
  else process.env.DEEPSEEK_CODE_DATA_DIR = savedDataDir;
  rmSync(sandbox, { recursive: true, force: true });
});

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");
const ENTER = "\r";
const DOWN = `${ESC}[B`;
const ESCAPE = ESC;
const SUGGESTION = `${ESC}[38;2;177;185;249m`;

class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode() {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

class FakeStdout extends PassThrough {
  columns = 100;
  rows = 40;
  isTTY = true;
  getColorDepth() {
    return 3;
  }
  hasColors() {
    return true;
  }
}

interface PanelRun {
  /** The last frame, SGR codes intact. */
  raw: string;
  /** The same frame with the codes stripped, for word-level assertions. */
  text: string;
  /** Every value the panel handed its host through `setTabsHidden`. */
  tabsHidden: boolean[];
  closes: number;
}

/** Mount the panel, send each key, and hand back the frame it settled on. */
async function driveConfig(...keys: string[]): Promise<PanelRun> {
  let out = "";
  const tabsHidden: boolean[] = [];
  const state = { closes: 0 };
  const stdout = new FakeStdout();
  stdout.write = (chunk: string) => {
    out += chunk;
    return true;
  };
  const stdin = new FakeStdin();
  const app = render(
    React.createElement(Config, {
      onClose: () => {
        state.closes += 1;
      },
      setTabsHidden: (hidden: boolean) => tabsHidden.push(hidden),
      contentHeight: 30,
    }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: false,
    },
  );
  await Bun.sleep(50);
  for (const key of keys) {
    stdin.write(key);
    await Bun.sleep(50);
  }
  await Bun.sleep(30);
  // Read the tab-row history before unmounting: the effect's cleanup reports
  // "shown again" as it tears down.
  const hidden = tabsHidden.slice();
  app.unmount();
  // log-update erases the previous frame line by line before writing the next,
  // so everything after the final erase is the frame on screen now.
  const raw = out.split(`${ESC}[2K`).pop() ?? "";
  return { raw, text: raw.replace(ANSI, ""), tabsHidden: hidden, closes: state.closes };
}

test("the caret sits on the first placeholder letter, not on a blank", async () => {
  const frame = await driveConfig();
  // The reference inverts `placeholder.charAt(0)`; the panel used to invert a
  // bare space, which left the caret looking like an extra blank column.
  expect(frame.raw).toContain(`${ESC}[7mS${ESC}[27m`);
  expect(frame.raw).toContain(`${ESC}[2mearch settings…${ESC}[22m`);
  // ...and the row is one column narrower for it.
  expect(frame.text).toContain("│ ⌕ Search settings…");
});

test("the search prefix dims out of focus instead of staying accented", async () => {
  const focused = await driveConfig();
  // Focused: the prefix is plain — not accented, not bold, not dim.
  expect(focused.raw).toContain(`⌕ ${ESC}[7mS`);
  expect(focused.raw).not.toContain(`${ESC}[1m`);
  // The border lights up in the suggestion token while the user types — SGR
  // 38;2;177;185;249 in the dark palette — and only then.
  expect(focused.raw).toContain(`${SUGGESTION}╭`);

  // Enter moves to the list; the row is left flat, not accented, and the
  // border drops back to a dim default.
  const listed = await driveConfig(ENTER);
  expect(listed.raw).toContain(`${ESC}[2m⌕ ${ESC}[22m`);
  expect(listed.raw).not.toContain(`${SUGGESTION}╭`);
  expect(listed.text).toContain("│ ⌕ Search settings…");
});

test("the query comes back raw once the list has focus", async () => {
  // "theme" typed into the box, then Enter to move into the list.
  const frame = await driveConfig("t", "h", "e", "m", "e", ENTER);
  expect(frame.text).toContain("⌕ theme");
  expect(frame.text).not.toContain('"theme"');
  expect(frame.text).toContain("Theme");
});

test("the focused row's label carries the suggestion token and no bold", async () => {
  const frame = await driveConfig(ENTER);
  expect(frame.text).toContain("❯ Model");
  expect(frame.raw).toContain(`${SUGGESTION}❯ Model${ESC}[39m`);
  // Bolding the label made the focused row heavier than the value beside it.
  expect(frame.raw).not.toContain(`${ESC}[1m`);
});

test("the panel sits inside the pane's inset and pads top and bottom", async () => {
  const frame = await driveConfig("\r");
  const lines = frame.text.split("\n");
  // The Pane insets its content by two columns; the panel used to add a third
  // and to start flush against the tab row. The search box is the first thing
  // drawn, at column zero of the pane, and the rule above it is blank (the
  // panel's marginY), as is the row under the hint.
  expect(lines[0]).toBe("");
  const box = lines.findIndex((line) => line.includes("╭"));
  expect(box).toBeGreaterThan(0);
  expect(lines[box]!.startsWith("╭")).toBe(true);
  expect(lines.at(-1)!.trim()).toBe("");
  // The row gutter still lines the labels up two columns in.
  expect(lines.some((line) => line.startsWith("❯ Model"))).toBe(true);
});

test("the list-mode hint names the keys the panel reads", async () => {
  const frame = await driveConfig(ENTER);
  expect(frame.text).toContain(
    "Space to change · Enter to save · / to search · Esc to cancel",
  );
});

test("Enter saves and closes; Space is what changes a row", async () => {
  const saved = await driveConfig(ENTER, ENTER);
  expect(saved.closes).toBe(1);

  // Space on the first row opens the model picker: the panel stays open and
  // the tab row is hidden for the picker.
  const changed = await driveConfig(ENTER, " ");
  expect(changed.closes).toBe(0);
  expect(changed.tabsHidden.at(-1)).toBe(true);
});

test("Space on the Theme row opens the theme picker instead of cycling", async () => {
  // ↓↓↓ from Model to Theme, then accept.
  const frame = await driveConfig(ENTER, DOWN, DOWN, DOWN, " ");
  expect(frame.text).toContain("Choose the text style that looks best with your terminal");
  expect(frame.text).toContain("Enter to select · Esc to cancel");
  // The picker covers the panel: the row list is gone, and so is the search
  // box the value used to flip beside.
  expect(frame.text).not.toContain("Skip permission prompts");
  expect(frame.text).not.toContain("⌕");
  expect(frame.tabsHidden.at(-1)).toBe(true);
});

test("Space on the Model row opens the model list, not an edit field", async () => {
  const frame = await driveConfig(ENTER, " ");
  expect(frame.text).toContain("Advanced reasoning with extended thinking");
  expect(frame.text).toContain("Enter to confirm · Esc to cancel");
  expect(frame.text).not.toContain("✎ Edit Model:");
  expect(frame.text).not.toContain("Copy full response");
});

test("Escape closes the picker and gives the panel back", async () => {
  const frame = await driveConfig(ENTER, " ", ESCAPE);
  expect(frame.text).toContain("Space to change · Enter to save");
  expect(frame.text).toContain("Copy full response");
  expect(frame.tabsHidden.at(-1)).toBe(false);
});

test("the search-mode hint reads like the reference's", async () => {
  const frame = await driveConfig();
  expect(frame.text).toContain("Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear");
});

test("/ opens an empty search rather than filtering for a slash", async () => {
  const frame = await driveConfig(ENTER, "/");
  expect(frame.text).toContain("Type to filter");
  expect(frame.text).toContain("⌕ Search settings…");
  expect(frame.text).not.toContain('No settings match "/"');
});
