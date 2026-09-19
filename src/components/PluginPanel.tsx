import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../utils/theme.js";
import {
  ENABLE_FOOTER_HINT,
  INSTALL_FOOTER_HINT,
  enableWarning,
  installWarning,
  resolveInstallKey,
} from "./pluginInstall.js";
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
  /** The marketplace entry Enter was pressed on, waiting for a yes. */
  const [pendingInstall, setPendingInstall] = useState<MarketplaceEntry | null>(null);
  /** The disabled plugin Enter was pressed on, waiting for a yes. */
  const [pendingEnable, setPendingEnable] = useState<string | null>(null);

  
  const reloadLocal = () => {
    try {
      const list = loadInstalledPlugins();
      setInstalled(list);
    } catch {}
  };

  useEffect(() => {
    reloadLocal();
  }, []);

  
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

  
  const listSize = useMemo(() => {
    return activeTab === "installed" ? installed.length : marketplace.length;
  }, [activeTab, installed, marketplace]);

  
  useEffect(() => {
    if (selectedIndex >= listSize) {
      setSelectedIndex(Math.max(0, listSize - 1));
    }
  }, [listSize, selectedIndex]);

  
  /**
   * Clone a marketplace entry and wire it in.
   *
   * Reached only through the confirmation below: an installed plugin is
   * *enabled* (loadInstalledPlugins treats anything but an explicit `false` as
   * on), which means its MCP servers are spawned, its skills become slash
   * commands and its agents join the pool. None of that is visible from the
   * list the entry was picked out of.
   */
  const runInstall = async (entry: MarketplaceEntry) => {
    setInstallingPluginName(entry.name);
    setStatusMessage(`Installing plugin "${entry.name}"...`);
    try {
      const ok = await installPlugin(entry.name, entry.repository);
      if (ok) {
        reloadLocal();
        onRefreshPlugins();
        setStatusMessage(`✓ Plugin "${entry.name}" installed successfully!`);
      } else {
        setStatusMessage(`✗ Failed to install "${entry.name}". Check repo URL or manifest.`);
      }
    } catch {
      setStatusMessage(`✗ Error installing plugin.`);
    } finally {
      setInstallingPluginName(null);
    }
  };

  /**
   * Turn a disabled plugin back on, which grants what installing one grants.
   *
   * Reached only through the confirmation below. Enabling spawns the plugin's
   * MCP servers on the next session build — commands from whoever published the
   * repo — so it is the same decision as installing, and asks the same way.
   */
  const runEnable = (name: string) => {
    togglePlugin(name, true);
    reloadLocal();
    onRefreshPlugins();
    setStatusMessage(`✓ Plugin "${name}" enabled.`);
  };

  useInput(async (input, key) => {
    // A confirmation owns the keyboard while it is up — Escape included, which
    // here means "no" rather than "close the panel". Install and enable share
    // the keys and the shape of the question, because they grant the same three
    // things; only one of them can be up at a time.
    if (pendingInstall || pendingEnable) {
      const action = resolveInstallKey(input, key);
      if (action === "confirm") {
        const entry = pendingInstall;
        const name = pendingEnable;
        setPendingInstall(null);
        setPendingEnable(null);
        if (entry) await runInstall(entry);
        else if (name) runEnable(name);
      } else if (action === "cancel") {
        setStatusMessage(
          pendingInstall
            ? `Cancelled — "${pendingInstall.name}" was not installed.`
            : `Cancelled — "${pendingEnable}" was left disabled.`,
        );
        setPendingInstall(null);
        setPendingEnable(null);
      }
      return;
    }

    if (key.escape || input === "q") {
      onClose();
      return;
    }

    
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

    
    if (activeTab === "installed" && installed.length > 0) {
      const selected = installed[selectedIndex];
      if (!selected) return;

      if (key.return || input === " ") {
        // Enabling starts the plugin's MCP servers, so it asks — the same
        // question, for the same reason, as installing one. Disabling takes a
        // capability away and needs no ceremony; a prompt there would only
        // train the user to answer yes.
        if (!selected.enabled) {
          setPendingEnable(selected.name);
          return;
        }
        togglePlugin(selected.name, false);
        reloadLocal();
        onRefreshPlugins();
        setStatusMessage(`✓ Plugin "${selected.name}" disabled.`);
        return;
      }

      if (input === "d" || key.delete) {
        
        uninstallPlugin(selected.name);
        reloadLocal();
        onRefreshPlugins();
        setStatusMessage(`✓ Plugin "${selected.name}" uninstalled.`);
        setSelectedIndex(0);
        return;
      }
    }

    
    if (activeTab === "browse" && marketplace.length > 0 && !installingPluginName) {
      const selected = marketplace[selectedIndex];
      if (!selected) return;

      if (key.return) {
        
        const isInstalled = installed.some((p) => p.name === selected.name);
        if (isInstalled) {
          setStatusMessage(`Plugin "${selected.name}" is already installed.`);
          return;
        }

        // Previously this cloned and activated on the one keystroke. Ask
        // first — see runInstall for what the yes grants.
        setPendingInstall(selected);
      }
    }
  });

  // At most one confirmation is up. Install and enable grant the same three
  // things and take the same keys, so they share a render — a second block
  // would be a second place for the advertised hint to drift from the handler.
  const pendingWarning = pendingInstall
    ? installWarning(pendingInstall.name)
    : pendingEnable
      ? enableWarning(pendingEnable)
      : null;
  const pendingHint = pendingInstall ? INSTALL_FOOTER_HINT : ENABLE_FOOTER_HINT;

  const termWidth = process.stdout.columns || 80;
  const dividerLine = "─".repeat(termWidth);

  return (
    <Box flexDirection="column" width="100%" paddingX={1} marginY={0}>
      <Text color="gray">{dividerLine}</Text>

      {}
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

      {}
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

      {}
      {pendingWarning && (
        <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
          <Text bold color="yellow">{pendingWarning.heading}</Text>
          {pendingWarning.body.map((line) => (
            <Text key={line} color="gray">
              {line}
            </Text>
          ))}
          {}
          <Text color="gray">{pendingHint}</Text>
        </Box>
      )}

      {}
      {statusMessage && !pendingWarning && (
        <Box paddingLeft={2} paddingTop={1}>
          <Text bold color="yellow">
            {statusMessage}
          </Text>
        </Box>
      )}

      {}
      <Box paddingLeft={2} paddingTop={1}>
        <Text dimColor color="gray">
          {pendingWarning
            ? pendingHint
            : activeTab === "installed"
              ? "↑↓ select · Tab switch tabs · Space/Enter toggle · d uninstall · Esc exit"
              : "↑↓ select · Tab switch tabs · Enter install · Esc exit"}
        </Text>
      </Box>
      <Text color="gray">{dividerLine}</Text>
    </Box>
  );
}
