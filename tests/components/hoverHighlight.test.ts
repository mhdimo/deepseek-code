/**
 * Hover = the pointer's highlight.
 *
 * A no-button motion report (`?1003h`, SGR 32|3) makes the row under the
 * pointer the focused row — the same highlight the arrow keys drive — and
 * NEVER activates anything: no answer, no toggle, no navigation, no export.
 * A keystroke afterwards (Enter, Space) acts on the row the pointer moved to,
 * which is what makes the highlight real rather than cosmetic.
 *
 * Every case below goes through the real path: an SGR motion report written
 * to fake stdin, ink's parser, useMouseSelection's single parse loop, and
 * createHoverDispatcher's yoga-rect walk over the registered regions.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { useState } from "react";
import { Text } from "ink";
import { elementRect } from "../../src/components/mouseRegions.js";
import {
  move,
  mountWithMouse,
  report,
  settle,
  write,
  type MountedMouseApp,
} from "./mouseTestHarness.js";

// Sandbox the data dir BEFORE the settings/tasks modules read it.
process.env.DEEPSEEK_CODE_DATA_DIR = mkdtempSync(join(tmpdir(), "dshover-"));

let apps: MountedMouseApp[] = [];
afterEach(() => {
  for (const app of apps) app.unmount();
  apps = [];
});

function mount(node: React.ReactElement): MountedMouseApp {
  const app = mountWithMouse(node);
  apps.push(app);
  return app;
}

/** Point at `row` of the region at `regionIndex` (0-based yoga row), and let
 *  the resulting re-render land. Single-row regions — most ClickRegionBoxes,
 *  e.g. Select's — are addressed as (rowIndex, 0); a whole-list region like
 *  the command picker's is (0, visibleRow). */
async function hoverRow(
  app: MountedMouseApp,
  regionIndex: number,
  row: number,
): Promise<void> {
  const region = [...app.registry.regions.values()][regionIndex]!;
  const rect = elementRect(region.ref.current)!;
  await move(app, rect.left + 1, rect.top + row + 1);
  await settle();
  await settle();
}

const commands = [
  { name: "help", description: "Show help", usage: ["/help"] },
  { name: "model", description: "Pick a model", usage: ["/model "] },
  { name: "skills", description: "List skills", usage: ["/skills "] },
] as never;

describe("the command picker", () => {
  /** The picker is controlled by App, so the host holds the index — the same
   *  shape `onHover` is wired in. The probe Text reads it back out. */
  function hostWith(
    Picker: React.ComponentType<never>,
    picked: number[],
  ): React.ComponentType {
    return function Host(): React.ReactElement {
      const [index, setIndex] = useState(0);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(Picker, {
          commands,
          selectedIndex: index,
          onPick: (i: number) => picked.push(i),
          onHover: setIndex,
        } as never),
        React.createElement(Text, null, `index=${index}`),
      );
    };
  }

  test("hovering a row highlights it and picks nothing", async () => {
    const { default: CommandPicker } = await import("../../src/components/CommandPicker.js");
    const picked: number[] = [];
    const Host = hostWith(CommandPicker, picked);
    const app = mount(React.createElement(Host));
    await settle();
    expect(app.frame()).not.toContain("index=1");

    await hoverRow(app, 0, 1); // the second command row
    expect(picked).toEqual([]); // a pointer move is never an activation
    expect(app.frame()).toContain("index=1");
  });

  test("drags, wheels and motion releases are not hovers", async () => {
    const { default: CommandPicker } = await import("../../src/components/CommandPicker.js");
    const picked: number[] = [];
    const Host = hostWith(CommandPicker, picked);
    const app = mount(React.createElement(Host));
    await settle();
    const region = [...app.registry.regions.values()][0]!;
    const rect = elementRect(region.ref.current)!;
    // 32 = motion bit + left button (a drag), 64 = wheel up, and the release
    // ("m") of a motion report — none of them is a bare pointer move.
    await write(app, report(32, rect.left + 1, rect.top + 2));
    await write(app, report(64, rect.left + 1, rect.top + 2));
    await write(app, report(35, rect.left + 1, rect.top + 2, "m"));
    await settle();
    await settle();
    expect(picked).toEqual([]);
    expect(app.frame()).not.toContain("index=1");
  });
});

describe("the @-mention list", () => {
  test("hovering a row highlights it and fills nothing", async () => {
    const { default: FileMentions } = await import("../../src/components/FileMentions.js");
    const picked: number[] = [];
    const matches = ["src/a.ts", "src/b.ts", "src/c.ts"];
    function Host(): React.ReactElement {
      const [index, setIndex] = useState(0);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(FileMentions, {
          matches,
          selectedIndex: index,
          query: "src",
          onPick: (i: number) => picked.push(i),
          onHover: setIndex,
        }),
        React.createElement(Text, null, `index=${index}`),
      );
    }
    const app = mount(React.createElement(Host));
    await settle();
    await hoverRow(app, 0, 2);
    expect(picked).toEqual([]); // the mention is not filled in
    expect(app.frame()).toContain("index=2");
  });
});

describe("Select", () => {
  test("hovering focuses the row without picking; Enter picks the highlight", async () => {
    const { Select } = await import("../../src/ui/design-system/Select.js");
    const changed: string[] = [];
    const focused: string[] = [];
    const app = mount(
      React.createElement(Select, {
        options: [
          { label: "Alpha", value: "a" },
          { label: "Beta", value: "b" },
          { label: "Gamma", value: "c" },
        ],
        onChange: (v: string) => changed.push(v),
        onCancel: () => {},
        onFocus: (v: string) => focused.push(v),
      }) as never,
    );
    await settle();
    await hoverRow(app, 1, 0); // the second option's own row
    expect(changed).toEqual([]); // hover must not confirm the option
    expect(focused.at(-1)).toBe("b"); // …only move the focus there
    await write(app, "\r");
    await settle();
    expect(changed).toEqual(["b"]);
  });
});

describe("the permission prompt's rows", () => {
  test("hovering focuses a row without deciding; Enter decides on it", async () => {
    const { PermissionSelect } = await import("../../src/components/PermissionPrompt.js");
    const selected: string[] = [];
    const focused: string[] = [];
    const app = mount(
      React.createElement(PermissionSelect, {
        options: [
          { type: "text", label: "Yes", value: "yes" },
          { type: "text", label: "No", value: "no" },
        ],
        onSelect: (v: string) => selected.push(v),
        onCancel: () => {},
        onFocusChange: (v: string) => focused.push(v),
        onInputModeToggle: () => {},
      }) as never,
    );
    await settle();
    await hoverRow(app, 1, 0); // the second row's own region
    expect(selected).toEqual([]); // hovering never approves anything
    expect(focused.at(-1)).toBe("no");
    await write(app, "\r");
    await settle();
    expect(selected).toEqual(["no"]);
  });
});

describe("the question prompt", () => {
  test("hovering focuses a row without answering; Enter answers on it", async () => {
    const { default: AskUserQuestionsPrompt } = await import(
      "../../src/components/AskUserQuestionsPrompt.js"
    );
    const results: unknown[] = [];
    const question = {
      question: "Which database should we use?",
      header: "Database",
      options: [
        { label: "Postgres", description: "Reliable relational store" },
        { label: "SQLite", description: "Embedded, zero-config" },
      ],
    };
    const app = mount(
      React.createElement(AskUserQuestionsPrompt, {
        questions: [question],
        onResult: (r: unknown) => results.push(r),
      }) as never,
    );
    await settle();
    await hoverRow(app, 1, 0); // the second option's own row
    expect(results).toEqual([]); // hover alone answers nothing
    await write(app, "\r");
    await settle();
    await settle();
    expect(results.length).toBe(1);
    expect(JSON.stringify(results[0])).toContain("SQLite");
  });
});

describe("the skills menu", () => {
  test("hovering a row highlights it without opening the detail", async () => {
    const { listSkills } = await import("../../src/skills/skillService.js");
    const { default: SkillsMenu, groupSkills } = await import(
      "../../src/components/SkillsMenu.js"
    );
    const rows = groupSkills(listSkills()).flatMap((group) => group.rows);
    expect(rows.length).toBeGreaterThan(1);

    const app = mount(React.createElement(SkillsMenu, { onClose: () => {} }));
    await settle();
    await hoverRow(app, 1, 0); // the second skill row
    expect(app.frame()).not.toContain("Skill: "); // no detail pane
    await write(app, "\r");
    await settle();
    await settle();
    expect(app.frame()).toContain(`Skill: ${rows[1]!.name}`);
  });
});

describe("the task list", () => {
  test("hovering a row focuses it without opening the detail; Enter opens it", async () => {
    const { registerTask } = await import("../../src/services/tasks/backgroundFramework.js");
    registerTask("echo hover-one", { cwd: tmpdir(), type: "shell" });
    registerTask("echo hover-two", { cwd: tmpdir(), type: "shell" });
    const { default: TasksView, sortTasksForList } = await import(
      "../../src/components/TasksView.js"
    );
    const { listTasks } = await import("../../src/services/tasks/backgroundFramework.js");
    const { taskDescriptionOf } = await import("../../src/utils/taskLabels.js");
    // The row order is the view's own — read it rather than assume it. The
    // two descriptions differ, so the title below names exactly one row.
    const second = sortTasksForList(listTasks())[1]!;
    const secondDescription = taskDescriptionOf(second);

    const app = mount(React.createElement(TasksView, { onClose: () => {} }));
    await settle();
    await hoverRow(app, 1, 0); // the second task's row
    expect(app.frame()).not.toContain("shell › "); // no detail dialog
    await write(app, "\r");
    await settle();
    await settle();
    // Enter opened the SECOND row's task — i.e. the pointer really moved the
    // cursor, rather than Enter re-opening whatever was focused before.
    expect(app.frame()).toContain(`shell › ${secondDescription}`);
  });
});

describe("the export options", () => {
  test("hovering a row focuses it without running it; Enter runs it", async () => {
    const { default: ExportView } = await import("../../src/components/ExportView.js");
    let saved = 0;
    const app = mount(
      React.createElement(ExportView, {
        onCancel: () => {},
        onExport: () => ({ success: true, message: "exported" }),
        onSaveToFile: () => {
          saved += 1;
          return { success: true, message: "saved" };
        },
        onDone: () => {},
      }) as never,
    );
    await settle();
    await hoverRow(app, 1, 1); // the second option row ("Save to file")
    expect(saved).toBe(0); // hover never runs the row
    expect(app.frame()).not.toContain("Enter filename:");
    await write(app, "\r");
    await settle();
    await settle();
    expect(app.frame()).toContain("Enter filename:");
  });
});

describe("the settings list", () => {
  test("hovering a row moves the cursor without changing the setting", async () => {
    const { buildSettingsRows } = await import("../../src/components/settingsRows.js");
    const { loadSettings } = await import("../../src/state/storage.js");
    const rows = buildSettingsRows({ settings: loadSettings(), persist: () => {} });
    const target = rows.findIndex((r) => r.id === "copyFullResponse");
    expect(target).toBeGreaterThan(0);
    const before = rows[target]!.value;
    const value = () =>
      buildSettingsRows({ settings: loadSettings(), persist: () => {} })[target]!.value;

    const { default: Config } = await import("../../src/components/Settings/Config.js");
    const app = mount(
      React.createElement(Config, {
        onClose: () => {},
        setTabsHidden: () => {},
        contentHeight: 30,
      }),
    );
    await settle();
    // ↓ leaves the search box, which is what puts the list (and its pointer)
    // in charge — the same first step a keyboard user takes.
    await write(app, "\x1b[B");
    await settle();
    await hoverRow(app, target, 0);
    expect(value()).toBe(before); // a pointer move never toggles the row
    // Space acts on the highlight the pointer moved: without the hover this
    // would have toggled row 0's setting instead.
    await write(app, " ");
    await settle();
    expect(value()).toBe(!before);
  });
});

describe("motion vs the transcript", () => {
  test("a pointer move never starts a text selection", async () => {
    const app = mountWithMouse(React.createElement(Text, null, "hello"), {
      chat: {
        getViewport: () => ({ topOffset: 0, scrollTop: 0, totalRows: 50, width: 100 }),
      },
    });
    apps.push(app);
    await settle();
    await move(app, 5, 3); // inside the transcript's rows
    await settle();
    expect(app.selections).toEqual([]);
  });
});
