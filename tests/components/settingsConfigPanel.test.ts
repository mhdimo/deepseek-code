/**
 * What the Config panel actually puts on screen.
 *
 * The row list has been rebuilt twice and each time a row survived that wrote a
 * key nothing read back. Rendering the panel is the only way to catch that
 * class of defect short of a TTY: the rows, the value column and the scroll
 * markers are all decided here, and a row that reaches no consumer shows up as
 * a line of text right next to the ones that work.
 *
 * Home and the data dir are redirected before the import, as in
 * tests/config/persistedBypass.test.ts — the panel reads the user's settings
 * file, and the assertions below are about what the panel shows for a known
 * file rather than about whoever's settings happen to be on this machine.
 */
import { afterAll, expect, test } from "bun:test";
import React from "react";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-config-panel-"));
const home = join(sandbox, "home");
const dataDir = join(sandbox, "data");
mkdirSync(home, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const savedHome = process.env.HOME;
const savedDataDir = process.env.DEEPSEEK_CODE_DATA_DIR;
process.env.HOME = home;
process.env.DEEPSEEK_CODE_DATA_DIR = dataDir;

const settingsPath = join(dataDir, "settings.json");
let clock = 1_700_000_000;
function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  // loadSettings caches against the file's mtime.
  clock += 10;
  utimesSync(settingsPath, clock, clock);
}

const { renderToString } = await import("ink");
const { default: Config } = await import("../../src/components/Settings/Config");

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedDataDir === undefined) delete process.env.DEEPSEEK_CODE_DATA_DIR;
  else process.env.DEEPSEEK_CODE_DATA_DIR = savedDataDir;
  rmSync(sandbox, { recursive: true, force: true });
});

function renderPanel(contentHeight = 30): string {
  return renderToString(
    React.createElement(Config, {
      onClose: () => {},
      setTabsHidden: () => {},
      contentHeight,
    }),
  );
}

test("shows the rows whose values the app reads back", () => {
  writeSettings({
    schemaVersion: 3,
    model: "deepseek-reasoner",
    copyFullResponse: true,
    dangerouslySkipPermissions: false,
    thinkingMode: "whale",
  });
  const frame = renderPanel();

  expect(frame).toContain("Skip permission prompts");
  expect(frame).toContain("Copy full response");
  expect(frame).toContain("Thinking mode");
  expect(frame).toContain("whale");
  expect(frame).toContain("deepseek-reasoner");
  expect(frame).toContain("true");
});

test("drops the rows that reached nothing", () => {
  const frame = renderPanel();
  // spinnerTipsEnabled: the spinner has no tip line to hide.
  expect(frame).not.toContain("Spinner tips");
  // verbose: no TUI consumer; only the --print flag reads a verbose option.
  expect(frame).not.toContain("Verbose output");
  // provider: loadConfig overwrites it with "deepseek" before anyone looks.
  expect(frame).not.toContain("Provider");
});

test("scrolls the list inside the pane it was given", () => {
  const frame = renderPanel(15);
  // 15 rows against a 5-row window: the rest is announced, not silently cut.
  expect(frame).toContain("↓ 10 more below");
  expect(frame).not.toContain("more above");
  expect(frame).not.toContain("Cleanup period");
  // A pane tall enough for the list has nothing to announce.
  expect(renderPanel(30)).not.toContain("more below");
});

test("starts in search mode with the hint that matches", () => {
  const frame = renderPanel();
  expect(frame).toContain("Search settings…");
  expect(frame).toContain("Type to filter");
  // Enter in search moves to the list rather than toggling the first row.
  expect(frame).not.toContain("❯");
});
