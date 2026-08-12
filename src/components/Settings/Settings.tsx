// Settings — the /config shell: a permission-colored Pane hosting a Tabs row
// (Status / Config / Usage). Esc dismisses; left/right arrows switch tabs
// (handled by Tabs). Content height is fixed so switching tabs doesn't shift
// the pane.
//
// Ported from claude-code-main/src/components/Settings/Settings.tsx onto
// stock Ink: fork-ink keybindings (confirm:no) become a plain useInput escape
// handler; useModalOrTerminalSize becomes stdout.rows; the Gates tab is
// dropped. The config search-mode Esc handoff (onIsSearchModeChange →
// configOwnsEsc) is kept: while Config's search owns the keyboard, Esc clears
// the query rather than closing the pane. The Config/Usage tabs are owned by
// sibling agents — see the CONTRACT notes below.

import React, { Suspense, useState } from "react";
import { useInput, useStdout } from "ink";
import { Pane } from "../../ui/design-system/Pane.js";
import { Tabs, Tab } from "../../ui/design-system/Tabs.js";
import { Status } from "./Status.js";
import Config from "./Config.js";
import { Usage } from "./Usage.js";

export type SettingsProps = {
  onClose: () => void;
  context?: unknown;
  defaultTab: "Status" | "Config" | "Usage";
};

export function Settings({
  onClose,
  context,
  defaultTab,
}: SettingsProps): React.ReactNode {
  const [selectedTab, setSelectedTab] = useState<string>(defaultTab);
  const [tabsHidden, setTabsHidden] = useState(false);
  // True while Config's search mode owns the keyboard (search mode with
  // content focus). Settings must cede Esc so search can clear/exit first.
  const [configOwnsEsc, setConfigOwnsEsc] = useState(false);
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 24;

  // Fixed content height so switching tabs doesn't shift the pane height.
  // Capped at min(80% viewport, 30).
  const contentHeight = Math.max(
    15,
    Math.min(Math.floor(rows * 0.8), 30),
  );

  // Esc dismisses — unless a submenu is open (tabsHidden means Config's
  // inline edit is showing; it owns Esc to cancel) or Config's search mode
  // owns the keyboard (search clears the query first, then exits).
  useInput(
    (_input, key) => {
      if (key.escape && !tabsHidden) {
        onClose();
      }
    },
    {
      isActive:
        !tabsHidden &&
        !(selectedTab === "Config" && configOwnsEsc),
    },
  );

  const tabs = [
    <Tab key="status" title="Status">
      <Status />
    </Tab>,
    <Tab key="config" title="Config">
      <Suspense fallback={null}>
        <Config
          context={context}
          onClose={onClose}
          setTabsHidden={setTabsHidden}
          onIsSearchModeChange={setConfigOwnsEsc}
          contentHeight={contentHeight}
        />
      </Suspense>
    </Tab>,
    <Tab key="usage" title="Usage">
      <Usage />
    </Tab>,
  ];

  return (
    <Pane color="permission">
      <Tabs
        color="permission"
        selectedTab={selectedTab}
        onTabChange={setSelectedTab}
        hidden={tabsHidden}
        // Config has interactive content — start with the header unfocused
        // so left/right/tab select option values instead of switching tabs.
        initialHeaderFocused={defaultTab !== "Config"}
        // Inside a submenu (tabsHidden) skip the Tabs-level cap so all tabs
        // flow to their natural height; Config still gets contentHeight above.
        contentHeight={tabsHidden ? undefined : contentHeight}
      >
        {tabs}
      </Tabs>
    </Pane>
  );
}
