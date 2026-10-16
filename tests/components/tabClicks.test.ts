/**
 * The tab rows — Settings' Status/Config/Usage/Stats, /help, /permissions,
 * /stats — were keyboard-only: each tab renders as bare Text, so the click
 * layer had nothing to hit and the tabs could not be clicked at all.
 *
 * Every tab is now its own region running the same `selectTab` the arrow keys
 * run, so the mouse cannot drift from the keyboard. There is deliberately no
 * hover handler on a tab row: every other surface expresses a hover by moving
 * its cursor, which a tab cannot do without switching, and the hover
 * dispatcher has no "pointer left" event to clear a decoration with.
 */
import { afterEach, expect, test } from "bun:test";
import React from "react";
import { Text } from "ink";
import { Tab, Tabs } from "../../src/ui/design-system/Tabs.js";
import { elementRect } from "../../src/components/mouseRegions.js";
import {
  mountWithMouse,
  report,
  settle,
  write,
  type MountedMouseApp,
} from "./mouseTestHarness.js";

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

/** Three tabs, the first one current. */
function tabRow(over: Record<string, unknown> = {}): React.ReactElement {
  const tab = (id: string, title: string, pane: string): React.ReactElement =>
    React.createElement(Tab, {
      id,
      title,
      children: React.createElement(Text, null, pane),
    } as never);
  return React.createElement(Tabs, {
    title: "Settings:",
    defaultTab: "status",
    ...over,
    children: [
      tab("status", "Status", "status pane"),
      tab("config", "Config", "config pane"),
      tab("usage", "Usage", "usage pane"),
    ],
  } as never);
}

/** A left press in the middle of the tab at `index` of the row. */
async function clickTab(app: MountedMouseApp, index: number): Promise<void> {
  const region = [...app.registry.regions.values()][index];
  expect(region).toBeDefined(); // the tab is a click target at all
  const rect = elementRect(region!.ref.current)!;
  await write(app, report(0, rect.left + 1, rect.top + 1));
  await settle();
}

test("a click on a tab switches to it", async () => {
  const app = mount(tabRow());
  await settle();
  expect(app.frame()).toContain("status pane");

  const mark = app.frame().length;
  await clickTab(app, 1); // "Config"
  const after = app.frame().slice(mark);
  expect(after).toContain("config pane"); // the pane switched …
  expect(after).not.toContain("status pane"); // … and the old one went away
});

test("a controlled tab row reports the click through onTabChange", async () => {
  const changes: string[] = [];
  const app = mount(
    tabRow({ selectedTab: "status", onTabChange: (id: string) => changes.push(id) }),
  );
  await settle();

  const mark = app.frame().length;
  await clickTab(app, 2); // "Usage"
  expect(changes).toEqual(["usage"]);
  // The parent owns a controlled selection, so the pane does not move itself.
  expect(app.frame().slice(mark)).not.toContain("usage pane");
});

test("a tab row with navigation disabled is not clickable", async () => {
  const changes: string[] = [];
  const app = mount(
    tabRow({
      selectedTab: "status",
      onTabChange: (id: string) => changes.push(id),
      disableNavigation: true, // /stats' row is display-only
    }),
  );
  await settle();
  await clickTab(app, 1);
  expect(changes).toEqual([]);
});
