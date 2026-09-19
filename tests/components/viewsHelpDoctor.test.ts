/**
 * What /help, /export, /doctor and /hooks actually put on screen.
 *
 * These four screens are ports of Claude Code's HelpV2, ExportDialog,
 * Doctor and HooksConfigMenu, and the divergences that matter here are all
 * visible things: the frame a screen is drawn in, the rows it lists, the
 * guide at the bottom. Reading the frames back is the only way to catch a
 * screen that drifted back to its pre-port shape without a TTY.
 *
 * Home and the data dir are redirected before anything renders — /hooks and
 * /doctor read the user's settings file, and these assertions are about what
 * the screens show for a known file rather than for whoever's settings happen
 * to be on this machine.
 */
import { afterAll, expect, test } from "bun:test";
import React from "react";
import { EventEmitter } from "events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { render } from "ink";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-views-"));
const home = join(sandbox, "home");
const dataDir = join(sandbox, "data");
mkdirSync(home, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const savedHome = process.env.HOME;
const savedDataDir = process.env.DEEPSEEK_CODE_DATA_DIR;
process.env.HOME = home;
process.env.DEEPSEEK_CODE_DATA_DIR = dataDir;

// An unknown key makes validateSettings report one invalid setting, which is
// what draws /doctor's Invalid Settings section.
const settingsPath = join(dataDir, "settings.json");
writeFileSync(settingsPath, JSON.stringify({ bogusSettingKey: true }, null, 2));

import HelpView from "../../src/components/HelpView.js";
import { settleFrames } from "../helpers/inkFrames.js";
import ExportView from "../../src/components/ExportView.js";
import DoctorView from "../../src/components/DoctorView.js";
import HooksView from "../../src/components/HooksView.js";
import { resolveExportFile } from "../../src/components/ExportView.js";

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedDataDir === undefined) delete process.env.DEEPSEEK_CODE_DATA_DIR;
  else process.env.DEEPSEEK_CODE_DATA_DIR = savedDataDir;
  rmSync(sandbox, { recursive: true, force: true });
});

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

/**
 * Wait for the renderer to go quiet, rather than for a fixed number of
 * milliseconds. The frame assertions read the union of everything ink has
 * written, so a key that has not been processed yet — or a re-render that has
 * not landed — is indistinguishable from a screen that renders the wrong
 * thing. A fixed sleep only holds while the machine is idle: under load this
 * file failed one run in several, on whichever assertion happened to be
 * waiting when the delay ran out. See tests/helpers/inkFrames.ts.
 */
async function settle(read: () => string, waitMs?: number): Promise<void> {
  await settleFrames(read, { quietMs: waitMs ?? 40 });
}

async function renderFrame(
  node: React.ReactElement,
  waitMs = 60,
  keys: readonly string[] = [],
): Promise<string> {
  let out = "";
  // Ink needs an EventEmitter-shaped stdout and a raw-mode-capable stdin, and
  // only the parts it touches: this process has no TTY.
  const stdout = Object.assign(new EventEmitter(), {
    columns: 100,
    rows: 40,
    isTTY: true,
    write: (chunk: string) => {
      out += chunk;
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  });

  const { unmount, cleanup } = render(node, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
  });
  await settle(() => out, waitMs);
  for (const key of keys) {
    (stdin as unknown as PassThrough).write(key);
    await settle(() => out);
  }
  unmount();
  cleanup();
  return out.replace(ANSI, "");
}

/* ── /help (HelpV2) ─────────────────────────────────────────────────────── */

test("/help draws a Pane, not a rounded box", async () => {
  const frame = await renderFrame(React.createElement(HelpView, { version: "0.1.0" }));
  // The reference is a top rule + padding (design-system/Pane); the old port
  // wrapped the whole screen in a rounded Box.
  expect(frame).not.toContain("╭");
  expect(frame).not.toContain("╰");
  expect(frame).toContain("─");
});

test("/help hangs the version off a tab strip", async () => {
  const frame = await renderFrame(React.createElement(HelpView, { version: "0.1.0" }));
  expect(frame).toContain("DeepSeek Code v0.1.0");
  // Tabs render title and labels on one row, in order.
  const headerLine = frame
    .split("\n")
    .find((line) => line.includes("DeepSeek Code v0.1.0"));
  expect(headerLine).toBeDefined();
  expect(headerLine).toContain("general");
  expect(headerLine).toContain("commands");
  expect(headerLine).toContain("custom-commands");
});

test("/help switches tabs with the tab key, like the reference", async () => {
  const onMount = await renderFrame(React.createElement(HelpView, { version: "0.1.0" }));
  // The general tab is the default.
  expect(onMount).toContain("Shortcuts");
  expect(onMount).not.toContain("Browse default commands:");

  const afterTab = await renderFrame(
    React.createElement(HelpView, { version: "0.1.0" }),
    60,
    ["\t"],
  );
  expect(afterTab).toContain("Browse default commands:");
  expect(afterTab).toContain("/doctor");
});

test("/help heads the key list Shortcuts, as the reference General tab does", async () => {
  const frame = await renderFrame(React.createElement(HelpView, { version: "0.1.0" }));
  expect(frame).toContain("Shortcuts");
  expect(frame).not.toContain("Keyboard");
});

test("/help lists custom commands under their own tab", async () => {
  // Two tabs right of general, as in the reference's tab strip.
  const empty = await renderFrame(
    React.createElement(HelpView, { version: "0.1.0" }),
    60,
    ["\t", "\t"],
  );
  expect(empty).toContain("No custom commands found");

  const withCustom = await renderFrame(
    React.createElement(HelpView, {
      version: "0.1.0",
      customCommands: [{ name: "/deploy", description: "Ship it" }],
    }),
    60,
    ["\t", "\t"],
  );
  expect(withCustom).toContain("Browse custom commands:");
  expect(withCustom).toContain("/deploy");
  expect(withCustom).toContain("Ship it");
  expect(withCustom).not.toContain("No custom commands found");
});

/* ── /export (ExportDialog) ─────────────────────────────────────────────── */

const exportProps = {
  onCancel: () => {},
  onExport: () => ({ success: true, message: "saved" }),
};

test("/export offers the reference's two destinations", async () => {
  const frame = await renderFrame(React.createElement(ExportView, exportProps));
  expect(frame).toContain("Export Conversation");
  expect(frame).toContain("Select export method:");
  expect(frame).toContain("Copy to clipboard");
  expect(frame).toContain("Copy the conversation to your system clipboard");
  expect(frame).toContain("Save to file");
  expect(frame).toContain("Save the conversation to a file in the current directory");
  // The old format picker is gone.
  expect(frame).not.toContain("Save as Markdown");
  expect(frame).not.toContain("Save as JSON");
});

test("/export draws its frame through the Dialog pane", async () => {
  const frame = await renderFrame(React.createElement(ExportView, exportProps));
  expect(frame).not.toContain("╭");
  // The reference's option list implies Enter, so the guide is Esc alone.
  expect(frame).toContain("Esc to cancel");
  expect(frame).not.toContain("↑↓ select");
});

test("/export keeps the thinking toggle below the two destinations", async () => {
  const frame = await renderFrame(React.createElement(ExportView, exportProps));
  expect(frame).toContain("Include thinking/reasoning");
  expect(frame).toContain("[x]");
  // Order matches the screen: clipboard, file, then our extra toggle.
  expect(frame.indexOf("Copy to clipboard")).toBeLessThan(frame.indexOf("Save to file"));
  expect(frame.indexOf("Save to file")).toBeLessThan(frame.indexOf("Include thinking/reasoning"));
});

test("resolveExportFile derives the format from the typed extension", () => {
  // Mirrors ExportDialog.handleFilenameSubmit: a name with no extension gets
  // the default one; .json is what selects the JSON writer.
  expect(resolveExportFile("notes", "markdown")).toEqual({
    filename: "notes.md",
    format: "markdown",
  });
  expect(resolveExportFile("notes", "json")).toEqual({
    filename: "notes.json",
    format: "json",
  });
  expect(resolveExportFile("notes.json", "markdown")).toEqual({
    filename: "notes.json",
    format: "json",
  });
  expect(resolveExportFile("  notes.md  ", "json")).toEqual({
    filename: "notes.md",
    format: "markdown",
  });
});

/* ── /doctor (screens/Doctor) ───────────────────────────────────────────── */

test("/doctor is a Diagnostics pane of └ rows, not an icon checklist", async () => {
  // Port 9 refuses immediately, so the network check settles without waiting
  // out its 3s timeout and the finished frame is the one we read.
  const frame = await renderFrame(
    React.createElement(DoctorView, {
      provider: "deepseek",
      model: "deepseek-chat",
      baseURL: "http://127.0.0.1:9",
      onClose: () => {},
    }),
    400,
  );
  expect(frame).toContain("Diagnostics");
  expect(frame).toContain("└ Runtime:");
  expect(frame).toContain("└ C++ native engine:");
  expect(frame).toContain("└ Network:");
  // The reference has no status icons and no padded label column.
  expect(frame).not.toContain("✔");
  expect(frame).not.toContain("Runtime           ");
  // And the old title/subtitle pair is gone.
  expect(frame).not.toContain("DeepSeek Code doctor");
  expect(frame).not.toContain("Installation and connectivity diagnostics");
});

test("/doctor ends on the reference's Press Enter line", async () => {
  const frame = await renderFrame(
    React.createElement(DoctorView, {
      provider: "deepseek",
      model: "deepseek-chat",
      baseURL: "http://127.0.0.1:9",
      onClose: () => {},
    }),
    400,
  );
  expect(frame).toContain("Press Enter to continue…");
  // The old footer advertised a re-run key the reference does not have.
  expect(frame).not.toContain("r to re-run");
  expect(frame).not.toContain("Everything looks healthy");
});

test("/doctor prints invalid settings as the file plus a dim tree", async () => {
  const frame = await renderFrame(
    React.createElement(DoctorView, {
      provider: "deepseek",
      model: "deepseek-chat",
      baseURL: "http://127.0.0.1:9",
      onClose: () => {},
    }),
    400,
  );
  expect(frame).toContain("Invalid Settings");
  // The offending file, then the bad paths in an indented tree — not the old
  // flat "└ key: message" list.
  expect(frame).toContain(settingsPath);
  expect(frame).toContain("└ bogusSettingKey: unknown setting key");
});

/* ── /hooks (HooksConfigMenu) ───────────────────────────────────────────── */

test("/hooks opens on the event menu the reference shows first", async () => {
  const frame = await renderFrame(React.createElement(HooksView, { onClose: () => {} }));
  expect(frame).toContain("Hooks");
  expect(frame).toContain("0 hooks configured");
  // Every event is listed, with its dim description line.
  for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "Notification"]) {
    expect(frame).toContain(event);
  }
  expect(frame).toContain("before a tool runs");
  // The old title and the old subtitle prose are gone.
  expect(frame).not.toContain("Lifecycle hooks");
  expect(frame).not.toContain("saved to settings.json");
  // The event menu is the first screen, so no per-event action bar is shown.
  expect(frame).not.toContain("enable/disable");
});

test("/hooks accents the count of an event that has hooks", async () => {
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
        },
      },
      null,
      2,
    ),
  );
  const frame = await renderFrame(React.createElement(HooksView, { onClose: () => {} }));
  // The subtitle is the count alone — no trailing prose.
  const subtitle = frame.split("\n").find((line) => line.includes("configured"));
  expect(subtitle?.trim()).toBe("1 hook configured");
  expect(frame).toContain("PreToolUse (1)");
  // Events with no hooks carry no count at all.
  expect(frame).not.toContain("Stop (0)");
});
