












import React, { Suspense, useState } from "react";
import { useInput, useStdout } from "ink";
import { Pane } from "../../ui/design-system/Pane.js";
import { Tabs, Tab } from "../../ui/design-system/Tabs.js";
import type { ThemeSetting } from "../../utils/theme.js";
import type { ThinkingMode } from "../../types/index.js";
import { Status } from "./Status.js";
import Config from "./Config.js";
import { Usage } from "./Usage.js";
import { Stats } from "./Stats.js";

export type SettingsProps = {
  onClose: () => void;
  context?: unknown;
  defaultTab: "Status" | "Config" | "Usage" | "Stats";
  /** Config rows whose value the running session also reads; App owns the
   *  state behind them, so it owns the handlers too. */
  onSkipPermissionsChange?: (value: boolean) => void;
  onThinkingModeChange?: (mode: ThinkingMode) => void;
  onThemeModeChange?: (setting: ThemeSetting) => void;
};

export function Settings({
  onClose,
  context,
  defaultTab,
  onSkipPermissionsChange,
  onThinkingModeChange,
  onThemeModeChange,
}: SettingsProps): React.ReactNode {
  const [selectedTab, setSelectedTab] = useState<string>(defaultTab);
  const [tabsHidden, setTabsHidden] = useState(false);
  
  
  const [configOwnsEsc, setConfigOwnsEsc] = useState(false);
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 24;

  
  
  const contentHeight = Math.max(
    15,
    Math.min(Math.floor(rows * 0.8), 30),
  );

  
  
  
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
          onSkipPermissionsChange={onSkipPermissionsChange}
          onThinkingModeChange={onThinkingModeChange}
          onThemeModeChange={onThemeModeChange}
        />
      </Suspense>
    </Tab>,
    <Tab key="usage" title="Usage">
      <Usage />
    </Tab>,
    <Tab key="stats" title="Stats">
      <Stats />
    </Tab>,
  ];

  return (
    <Pane color="permission">
      {/* contentHeight pins the tab body so switching tabs (or opening
          Config's picker) does not resize the pane; it is dropped while a
          picker/editor covers the panel, as the reference does with
          `tabsHidden || insideModal`. */}
      <Tabs
        color="permission"
        selectedTab={selectedTab}
        onTabChange={setSelectedTab}
        hidden={tabsHidden}
        contentHeight={tabsHidden ? undefined : contentHeight}
        initialHeaderFocused={defaultTab !== "Config"}
        
        
        
      >
        {tabs}
      </Tabs>
    </Pane>
  );
}
