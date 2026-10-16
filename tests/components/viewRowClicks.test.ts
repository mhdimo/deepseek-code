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
import { mountWithMouse, report, settle, write, type MountedMouseApp } from "./mouseTestHarness.js";
import { elementRect, type RegionClickEvent } from "../../src/components/mouseRegions.js";

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

  test("rows are inert while an export is running and on the result screen", async () => {
    const { default: ExportView } = await import("../../src/components/ExportView.js");
    let calls = 0;
    let held: ((r: { success: boolean; message: string }) => void) | null = null;
    const app = mountView(
      React.createElement(ExportView, {
        onCancel: () => {},
        // A promise held open stands in for the host's real async file write
        // (App.tsx passes no onDone, so the result phase is reachable too).
        onExport: () => {
          calls += 1;
          return new Promise<{ success: boolean; message: string }>((resolve) => {
            held = resolve;
          });
        },
      }),
    );
    await settle();
    expect(app.handlers().length).toBe(2);

    // A real SGR left-press on the row's top-left cell: the phase gate lives
    // in the hit tester reading the region's enabled flag, so dispatching the
    // handler directly would bypass exactly what this test is about.
    const clickRow = async (index: number) => {
      const region = [...app.registry.regions.values()][index]!;
      const rect = elementRect(region.ref.current)!;
      await write(app, report(0, rect.left + 1, rect.top + 1));
      // Two settle windows (30fps render throttle), as in the test above.
      await settle();
      await settle();
    };

    await clickRow(1); // "Save to file" with no onSaveToFile → exports directly
    expect(calls).toBe(1);
    expect(app.frame()).toContain("Exporting…");

    // Mid-export a stray click must not start a second concurrent write.
    await clickRow(1);
    expect(calls).toBe(1);

    held!({ success: true, message: "exported" });
    await settle();
    await settle();
    expect(app.frame()).toContain("✓ exported");

    // The result screen keeps the rows on screen, but a click must not
    // re-export (the keyboard's Enter closes the dialog instead).
    await clickRow(1);
    expect(calls).toBe(1);
  });
});

describe("the input dialog's field", () => {
  test("clicking the field places the caret; typing continues there", async () => {
    const { default: InputDialog } = await import("../../src/components/InputDialog.js");
    const submissions: string[] = [];
    const app = mountView(
      React.createElement(InputDialog, {
        title: "Test",
        initial: "abcdef",
        onSubmit: (v: string) => submissions.push(v),
        onCancel: () => {},
      }),
    );
    await settle();
    // col 4: two cells into the text (the "> " prefix takes the first two).
    app.handlers()[0]!({ ...click, col: 4 });
    await write(app, "X");
    await write(app, "\r");
    await settle();
    expect(submissions).toEqual(["abXcdef"]);
  });

  test("right-click pastes at the caret", async () => {
    const { __setClipboardReaderForTests } = await import("../../src/components/clipboard.js");
    __setClipboardReaderForTests(() => "PASTED");
    try {
      const { default: InputDialog } = await import("../../src/components/InputDialog.js");
      const submissions: string[] = [];
      const app = mountView(
        React.createElement(InputDialog, {
          title: "Test",
          initial: "abcdef",
          onSubmit: (v: string) => submissions.push(v),
          onCancel: () => {},
        }),
      );
      await settle();
      // The right press goes through the real SGR path — the field's region
      // must opt into right clicks (else it is swallowed unconsumed). Aim at
      // the region's own top-left cell, read off the yoga tree, because the
      // Dialog chrome decides where that row lands on screen.
      const region = [...app.registry.regions.values()][0]!;
      const rect = elementRect(region.ref.current)!;
      await write(app, report(2, rect.left + 1, rect.top + 1));
      await settle();
      // The caret starts at the end of the initial value; the right-press
      // pastes there.
      await write(app, "\r");
      await settle();
      expect(submissions).toEqual(["abcdefPASTED"]);
    } finally {
      __setClipboardReaderForTests(null);
    }
  });
});
