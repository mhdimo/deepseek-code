












import React, { Suspense, useState } from "react";
import { useInput, useStdout } from "ink";
import { Pane } from "../../ui/design-system/Pane.js";
import { Tabs, Tab } from "../../ui/design-system/Tabs.js";
import { Status } from "./Status.js";
import Config from "./Config.js";
import { Usage } from "./Usage.js";
import { Stats } from "./Stats.js";

export type SettingsProps = {
  onClose: () => void;
  context?: unknown;
  defaultTab: "Status" | "Config" | "Usage" | "Stats";
};

export function Settings({
  onClose,
  context,
  defaultTab,
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
      <Tabs
        color="permission"
        selectedTab={selectedTab}
        onTabChange={setSelectedTab}
        hidden={tabsHidden}
        
        
        initialHeaderFocused={defaultTab !== "Config"}
        
        
        
      >
        {tabs}
      </Tabs>
    </Pane>
  );
}
