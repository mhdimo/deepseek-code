import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../utils/theme.js";
import {
  loadInstalledPlugins,
  togglePlugin,
  uninstallPlugin,
  fetchMarketplacePlugins,
  installPlugin,
  type InstalledPlugin,
  type MarketplaceEntry,
} from "../services/pluginService.js";

interface PluginPanelProps {
  onClose: () => void;
  onRefreshPlugins: () => void;
}

type TabType = "installed" | "browse";

export default function PluginPanel({ onClose, onRefreshPlugins }: PluginPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>("installed");
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [marketplace, setMarketplace] = useState<MarketplaceEntry[]>([]);
  
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isLoadingMarketplace, setIsLoadingMarketplace] = useState(false);
  const [installingPluginName, setInstallingPluginName] = useState<string | null>(null);

  // Reload local plugins
  const reloadLocal = () => {
    try {
      const list = loadInstalledPlugins();
      setInstalled(list);
    } catch {}
  };

  useEffect(() => {
    reloadLocal();
  }, []);

  // Fetch marketplace list when entering the browse tab
  useEffect(() => {
    if (activeTab === "browse" && marketplace.length === 0) {
      setIsLoadingMarketplace(true);
      setStatusMessage("Fetching plugins from marketplaces...");
      fetchMarketplacePlugins()
        .then((entries) => {
          setMarketplace(entries);
          setStatusMessage(entries.length > 0 ? null : "No plugins found in marketplaces.");
        })
        .catch(() => {
          setStatusMessage("Failed to fetch marketplace entries.");
        })
        .finally(() => {
          setIsLoadingMarketplace(false);
        });
    }
  }, [activeTab]);

  // Compute filtered/mapped arrays based on tab
  const listSize = useMemo(() => {
    return activeTab === "installed" ? installed.length : marketplace.length;
  }, [activeTab, installed, marketplace]);

  // Handle selected index clamping
  useEffect(() => {
    if (selectedIndex >= listSize) {
      setSelectedIndex(Math.max(0, listSize - 1));
    }
  }, [listSize, selectedIndex]);

  // Handle inputs
  useInput(async (input, key) => {
    if (key.escape || input === "q") {
      onClose();
      return;
    }

    // Switch tabs with Tab/Shift+Tab
    if (key.tab) {
      setActiveTab((prev) => (prev === "installed" ? "browse" : "installed"));
      setSelectedIndex(0);
      setStatusMessage(null);
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(listSize - 1, prev + 1));
      return;
    }

    // Installed Tab interactions: Toggle (Space/Enter) and Delete (d)
    if (activeTab === "installed" && installed.length > 0) {
      const selected = installed[selectedIndex];
      if (!selected) return;

      if (key.return || input === " ") {
        // Toggle enabled
        const nextState = !selected.enabled;
        togglePlugin(selected.name, nextState);
        reloadLocal();
        onRefreshPlugins(); // refresh loaded plugins in App.tsx
        setStatusMessage(`✓ Plugin "${selected.name}" ${nextState ? "enabled" : "disabled"}.`);
        return;
      }

      if (input === "d" || key.delete) {
        // Uninstall
        uninstallPlugin(selected.name);
        reloadLocal();
        onRefreshPlugins();
        setStatusMessage(`✓ Plugin "${selected.name}" uninstalled.`);
        setSelectedIndex(0);
        return;
      }
    }

    // Browse Tab interactions: Install (Enter)
    if (activeTab === "browse" && marketplace.length > 0 && !installingPluginName) {
      const selected = marketplace[selectedIndex];
      if (!selected) return;

      if (key.return) {
        // Check if already installed
        const isInstalled = installed.some((p) => p.name === selected.name);
        if (isInstalled) {
          setStatusMessage(`Plugin "${selected.name}" is already installed.`);
          return;
        }

        setInstallingPluginName(selected.name);
        setStatusMessage(`Installing plugin "${selected.name}"...`);

        try {
          const ok = await installPlugin(selected.name, selected.repository);
          if (ok) {
            reloadLocal();
            onRefreshPlugins();
            setStatusMessage(`✓ Plugin "${selected.name}" installed successfully!`);
          } else {
            setStatusMessage(`✗ Failed to install "${selected.name}". Check repo URL or manifest.`);
          }
        } catch {
          setStatusMessage(`✗ Error installing plugin.`);
        } finally {
          setInstallingPluginName(null);
        }
      }
    }
  });

  const termWidth = process.stdout.columns || 80;
  const dividerLine = "─".repeat(termWidth);

  return (
    <Box flexDirection="column" width="100%" paddingX={1} marginY={0}>
      <Text color="gray">{dividerLine}</Text>

      {/* Header / Tabs */}
      <Box flexDirection="row" paddingBottom={1} paddingLeft={2}>
        <Box marginRight={4}>
          <Text bold={activeTab === "installed"} color={activeTab === "installed" ? "cyan" : "gray"}>
            {activeTab === "installed" ? "▸ " : "  "}Installed Plugins ({installed.length})
          </Text>
        </Box>
        <Box>
          <Text bold={activeTab === "browse"} color={activeTab === "browse" ? "cyan" : "gray"}>
            {activeTab === "browse" ? "▸ " : "  "}Browse Marketplace ({marketplace.length})
          </Text>
        </Box>
      </Box>

      {/* List Area */}
      <Box flexDirection="column" paddingLeft={2} minHeight={6}>
        {activeTab === "installed" ? (
          installed.length === 0 ? (
            <Text color="gray">  No plugins installed. Switch to "Browse Marketplace" to find plugins.</Text>
          ) : (
            installed.map((p, idx) => {
              const active = idx === selectedIndex;
              return (
                <Box key={p.name} flexDirection="column" marginBottom={0}>
                  <Box flexDirection="row">
                    <Text color="cyan">{active ? "▶ " : "  "}</Text>
                    <Text bold color={active ? "cyan" : "white"}>
                      {p.name.padEnd(20)}
                    </Text>
                    <Text dimColor>v{p.manifest.version}</Text>
                    <Text>   </Text>
                    <Text color={p.enabled ? "green" : "red"}>
                      {p.enabled ? "[Enabled]" : "[Disabled]"}
                    </Text>
                  </Box>
                  {active && (
                    <Box paddingLeft={4} marginBottom={0}>
                      <Text dimColor>{p.manifest.description || "No description provided."}</Text>
                    </Box>
                  )}
                </Box>
              );
            })
          )
        ) : isLoadingMarketplace ? (
          <Text color="yellow">  Fetching available plugins...</Text>
        ) : (
          marketplace.map((m, idx) => {
            const active = idx === selectedIndex;
            const isInstalled = installed.some((p) => p.name === m.name);
            return (
              <Box key={m.name} flexDirection="column" marginBottom={0}>
                <Box flexDirection="row">
                  <Text color="cyan">{active ? "▶ " : "  "}</Text>
                  <Text bold color={active ? "cyan" : "white"}>
                    {m.name.padEnd(20)}
                  </Text>
                  <Text dimColor>v{m.version}</Text>
                  <Text>   </Text>
                  {isInstalled ? (
                    <Text color="green">[Installed]</Text>
                  ) : (
                    <Text color="gray">[Available]</Text>
                  )}
                </Box>
                {active && (
                  <Box paddingLeft={4} flexDirection="column" marginBottom={0}>
                    <Text dimColor>{m.description || "No description provided."}</Text>
                    <Text dimColor color="gray">Repo: {m.repository}</Text>
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>

      {/* Status Bar */}
      {statusMessage && (
        <Box paddingLeft={2} paddingTop={1}>
          <Text bold color="yellow">
            {statusMessage}
          </Text>
        </Box>
      )}

      {/* Footer Hints */}
      <Box paddingLeft={2} paddingTop={1}>
        <Text dimColor color="gray">
          {activeTab === "installed"
            ? "↑↓ select · Tab switch tabs · Space/Enter toggle · d uninstall · Esc exit"
            : "↑↓ select · Tab switch tabs · Enter install · Esc exit"}
        </Text>
      </Box>
      <Text color="gray">{dividerLine}</Text>
    </Box>
  );
}
