/**
 * The Settings shell pins the tab body to one height.
 *
 * The reference hands `contentHeight` to Tabs (`contentHeight={tabsHidden ||
 * insideModal ? undefined : contentHeight}`), which fixes the box the tab
 * content sits in and lets a long tab scroll inside it. Without the pin the
 * pane is as tall as whichever tab is open, so moving between tabs drags the
 * pane's top rule up and down over the frozen transcript behind it. The
 * heights below are frames the shell actually renders, not a constant.
 *
 * Home and the data dir are redirected before the imports: the Status tab
 * reads the settings file and the trust store.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "node:stream";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-settings-shell-"));
const home = join(sandbox, "home");
const dataDir = join(sandbox, "data");
mkdirSync(home, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const savedHome = process.env.HOME;
const savedDataDir = process.env.DEEPSEEK_CODE_DATA_DIR;
process.env.HOME = home;
process.env.DEEPSEEK_CODE_DATA_DIR = dataDir;

const React = (await import("react")).default;
const { render } = await import("ink");
const { Settings } = await import("../../src/components/Settings/Settings.js");

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedDataDir === undefined) delete process.env.DEEPSEEK_CODE_DATA_DIR;
  else process.env.DEEPSEEK_CODE_DATA_DIR = savedDataDir;
  rmSync(sandbox, { recursive: true, force: true });
});

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");

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
    return 1;
  }
  hasColors() {
    return false;
  }
}

async function tabFrame(tab: "Status" | "Config" | "Usage" | "Stats"): Promise<string> {
  let out = "";
  const stdout = new FakeStdout();
  stdout.write = (chunk: string) => {
    out += chunk;
    return true;
  };
  const app = render(
    React.createElement(Settings, {
      onClose: () => {},
      defaultTab: tab,
    }),
    {
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: false,
    },
  );
  await Bun.sleep(60);
  app.unmount();
  const raw = out.split(`${ESC}[2K`).pop() ?? "";
  const text = raw.replace(ANSI, "");
  // Keep the padded rows: they are the pin. Only the newline that ends the
  // frame comes off.
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** The pane's top rule: the first line that is a divider. */
function paneTop(frame: string): number {
  return frame.split("\n").findIndex((line) => line.trim().startsWith("─"));
}

test("every tab is drawn inside the same fixed-height pane", async () => {
  const frames: Record<string, string> = {};
  for (const tab of ["Status", "Config", "Usage", "Stats"] as const) {
    frames[tab] = await tabFrame(tab);
  }
  const heights = Object.fromEntries(
    Object.entries(frames).map(([tab, frame]) => [tab, frame.split("\n").length]),
  );
  // Switching tabs must not move the pane's top rule...
  const tops = Object.fromEntries(
    Object.entries(frames).map(([tab, frame]) => [tab, paneTop(frame)]),
  );
  expect(tops.Config).toBe(tops.Status);
  expect(tops.Usage).toBe(tops.Status);
  // ...and must not change how much room the pane takes, either: a tab whose
  // content is shorter than the pin is padded out to it, and the long one is
  // clipped to it rather than growing the pane.
  expect(heights.Config).toBe(heights.Status);
  expect(heights.Usage).toBe(heights.Status);
  expect(heights.Stats).toBe(heights.Status);
  // Status renders a handful of rows; the pane is the 30-row pin plus the
  // shell's four rows of chrome (pane padding, rule, tab row, its margin).
  expect(heights.Status).toBe(34);
});
