/**
 * Phase 3 views: settings rows, task rows, export rows, and the input
 * dialog's text field. Layout-dependent geometry is Task 1's job; these
 * tests dispatch to each view's registered row handlers and assert the same
 * state change the keyboard produces. The harness provides the real stdin
 * (several of these views type), the registry, and a frame buffer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { mountWithMouse, settle, write, type MountedMouseApp } from "./mouseTestHarness.js";
import type { RegionClickEvent } from "../../src/components/mouseRegions.js";

// Sandbox the data dir BEFORE the settings/tasks modules read it.
process.env.DEEPSEEK_CODE_DATA_DIR = mkdtempSync(join(tmpdir(), "dsclick-"));

const click: RegionClickEvent = { row: 0, col: 0, clickCount: 1, button: 0, width: 60, height: 1 };

let apps: MountedMouseApp[] = [];
afterEach(() => {
  for (const app of apps) app.unmount();
  apps = [];
});

/** Mount a view with the full click wiring; `handlers()` returns its
 *  registered row handlers in render order. */
export function mountView(
  node: React.ReactElement,
): MountedMouseApp & { handlers: () => Array<(ev: RegionClickEvent) => void> } {
  const app = mountWithMouse(node);
  apps.push(app);
  return Object.assign(app, {
    handlers: () => [...app.registry.regions.values()].map((r) => r.handlerRef.current),
  });
}

describe("settings rows", () => {
  test("clicking a boolean row toggles and persists it", async () => {
    const { buildSettingsRows } = await import("../../src/components/settingsRows.js");
    const { loadSettings } = await import("../../src/state/storage.js");
    const rows = buildSettingsRows({ settings: loadSettings(), persist: () => {} });
    // A plain boolean row — not skipPermissions, which is gated by bypass
    // mode. Pinned from settingsRows.ts (id "copyFullResponse").
    const targetIndex = rows.findIndex((r) => r.id === "copyFullResponse");
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    const before = rows[targetIndex]!.value;

    const { default: Config } = await import("../../src/components/Settings/Config.js");
    const app = mountView(
      React.createElement(Config, {
        onClose: () => {},
        setTabsHidden: () => {},
        contentHeight: 30,
      }),
    );
    await settle();
    // Config renders one region per setting row, in the same order
    // buildSettingsRows produced (no filter active, window fits 30 rows).
    expect(app.handlers().length).toBeGreaterThan(targetIndex);
    app.handlers()[targetIndex]!(click);
    await settle();

    const after = buildSettingsRows({ settings: loadSettings(), persist: () => {} })[targetIndex]!
      .value;
    expect(after).toBe(!before);
  });
});

describe("task rows", () => {
  test("clicking a task row opens its detail", async () => {
    const { registerTask } = await import("../../src/services/tasks/backgroundFramework.js");
    // Two real (instantly finishing) shell tasks so the list has two rows.
    // registerTask spawns a process, hence the sandboxed data dir above.
    registerTask("true", { cwd: tmpdir(), type: "shell" });
    registerTask("true", { cwd: tmpdir(), type: "shell" });

    const { default: TasksView } = await import("../../src/components/TasksView.js");
    const app = mountView(React.createElement(TasksView, { onClose: () => {} }));
    await settle();
    expect(app.handlers().length).toBe(2);
    app.handlers()[1]!(click); // the second task row
    // Two settle windows: ink throttles renders to 30fps (~33ms), so the
    // re-render a click causes reaches stdout a hair after one 30ms settle.
    await settle();
    await settle();
    // Enter's action ran: the detail dialog's output section is on screen
    // (TaskDetailDialog.tsx's shell render). Only assert strings written
    // after the click — the frame buffer keeps earlier frames' text, so a
    // not.toContain on list text would fail against that leftover.
    expect(app.frame()).toContain("output (last");
  });
});

describe("export rows", () => {
  test("clicking Save to file opens the filename step", async () => {
    const { default: ExportView } = await import("../../src/components/ExportView.js");
    const app = mountView(
      React.createElement(ExportView, {
        onCancel: () => {},
        onExport: () => ({ success: true, message: "exported" }),
        onCopy: () => ({ success: true, message: "copied" }),
        onSaveToFile: () => ({ success: true, message: "saved" }),
        onDone: () => {},
      }),
    );
    await settle();
    // Exactly the two option rows — the thinking toggle (its own Box below a
    // marginTop spacer) stays keyboard-only in v1.
    expect(app.handlers().length).toBe(2);
    app.handlers()[1]!(click); // "Save to file"
    // Two settle windows: ink's 30fps render throttle defers the re-render
    // past one 30ms settle (same reason as the task-rows test above).
    await settle();
    await settle();
    expect(app.frame()).toContain("Enter filename:");
  });
});
