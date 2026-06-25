import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../utils/theme.js";
import type { AgentName } from "../types/index.js";
import { loadGlobalStats } from "../state/stats.js";
import type { GlobalStats } from "../state/stats.js";
import { existsSync } from "fs";
import { join } from "path";

interface SettingsPanelProps {
  onClose: () => void;
  config: any;
  workingDirectory: string;
  activeModel: string;
  activeProvider: string;
  activeApiKey: string;
  activeBaseURL?: string;
  tokenCount: number;
  cost: number;
  apiDurationMs: number;
  sessionStartMs: number;
  linesAdded: number;
  linesRemoved: number;
  mcpCount: number;
  sessionId: string;
  initialTab?: "settings" | "status" | "config" | "usage" | "stats";
}

export type TabType = "settings" | "status" | "config" | "usage" | "stats";

const TABS: Array<{ id: TabType; label: string }> = [
  { id: "settings", label: "Settings" },
  { id: "status", label: "Status" },
  { id: "config", label: "Config" },
  { id: "usage", label: "Usage" },
  { id: "stats", label: "Stats" },
];

export default function SettingsPanel({
  onClose,
  config,
  workingDirectory,
  activeModel,
  activeProvider,
  activeApiKey,
  activeBaseURL,
  tokenCount,
  cost: sessionCost,
  apiDurationMs: sessionApiDurationMs,
  sessionStartMs,
  linesAdded: sessionLinesAdded,
  linesRemoved: sessionLinesRemoved,
  mcpCount,
  sessionId,
  initialTab = "usage",
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const [statsView, setStatsView] = useState<"overview" | "models">("overview");

  // Load global historical stats from disk
  const globalStats = useMemo(() => {
    try {
      const { loadGlobalStats } = require("../state/stats.js");
      return loadGlobalStats() as GlobalStats;
    } catch {
      return { sessions: [], dailyUsage: {} } as GlobalStats;
    }
  }, []);

  // Compute accumulated totals
  const totals = useMemo(() => {
    const sessionWallMs = Date.now() - sessionStartMs;

    let totalCost = sessionCost;
    let totalApiMs = sessionApiDurationMs;
    let totalWallMs = sessionWallMs;
    let totalLinesAdded = sessionLinesAdded;
    let totalLinesRemoved = sessionLinesRemoved;
    let totalSessionsCount = globalStats.sessions.length + 1; // including current

    // Model token tracking
    const modelTotals: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }> = {};
    modelTotals[activeModel] = {
      input: tokenCount,
      output: 0, // estimate or actual if available
      cacheRead: 0,
      cacheWrite: 0,
      cost: sessionCost,
    };

    globalStats.sessions.forEach((s) => {
      // Exclude current session from double counting if it's already saved
      if (s.id === sessionId) return;

      totalCost += s.cost;
      totalApiMs += s.apiDurationMs;
      totalWallMs += s.wallDurationMs;
      totalLinesAdded += s.linesAdded;
      totalLinesRemoved += s.linesRemoved;

      if (!modelTotals[s.model]) {
        modelTotals[s.model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      }
      const mt = modelTotals[s.model]!;
      mt.input += s.tokens.input;
      mt.output += s.tokens.output;
      mt.cacheRead += s.tokens.cacheRead;
      mt.cacheWrite += s.tokens.cacheWrite;
      mt.cost += s.cost;
    });

    return {
      totalCost,
      totalApiMs,
      totalWallMs,
      totalLinesAdded,
      totalLinesRemoved,
      totalSessionsCount,
      modelTotals,
    };
  }, [globalStats, sessionCost, tokenCount, sessionApiDurationMs, sessionStartMs, sessionLinesAdded, sessionLinesRemoved, activeModel, sessionId]);

  // Handle key navigation
  useInput((input, key) => {
    if (key.escape || input === "q") {
      onClose();
      return;
    }

    if (key.leftArrow) {
      const idx = TABS.findIndex((t) => t.id === activeTab);
      const nextIdx = (idx - 1 + TABS.length) % TABS.length;
      setActiveTab(TABS[nextIdx]!.id);
      return;
    }

    if (key.rightArrow) {
      const idx = TABS.findIndex((t) => t.id === activeTab);
      const nextIdx = (idx + 1) % TABS.length;
      setActiveTab(TABS[nextIdx]!.id);
      return;
    }

    if (activeTab === "stats") {
      if (key.downArrow || input === "s") {
        setStatsView((prev) => (prev === "overview" ? "models" : "overview"));
      }
    }
  });

  const formatDuration = (ms: number): string => {
    const totalSecs = Math.floor(ms / 1000);
    const secs = totalSecs % 60;
    const totalMins = Math.floor(totalSecs / 60);
    const mins = totalMins % 60;
    const totalHours = Math.floor(totalMins / 60);
    const hours = totalHours % 24;
    const days = Math.floor(totalHours / 24);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    if (mins > 0 || hours > 0 || days > 0) parts.push(`${mins}m`);
    parts.push(`${secs}s`);
    return parts.join(" ");
  };

  // Generate heatmap grid
  const heatmapGrid = useMemo(() => {
    const rows = 7;
    const cols = 52;
    const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill("·"));

    // Find the Sunday of the week 52 weeks ago
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 364);
    const startDay = startDate.getDay();
    startDate.setDate(startDate.getDate() - startDay); // align to Sunday

    // Fill grid values
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const d = new Date(startDate);
        d.setDate(startDate.getDate() + (c * 7) + r);
        const dateStr = d.toISOString().split("T")[0]!;
        let tokens = globalStats.dailyUsage[dateStr] || 0;

        // Include current session usage if it is today
        const todayStr = today.toISOString().split("T")[0]!;
        if (dateStr === todayStr) {
          tokens += tokenCount;
        }

        if (tokens === 0) {
          grid[r]![c] = "·";
        } else if (tokens < 10000) {
          grid[r]![c] = "░";
        } else if (tokens < 50000) {
          grid[r]![c] = "▒";
        } else if (tokens < 200000) {
          grid[r]![c] = "▓";
        } else {
          grid[r]![c] = "█";
        }
      }
    }

    // Generate Month Labels at correct column alignments
    const monthLabels = Array(cols).fill(" ");
    let lastMonth = -1;
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    for (let c = 0; c < cols; c++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + (c * 7));
      const m = d.getMonth();
      if (m !== lastMonth) {
        monthLabels[c] = monthNames[m]!;
        lastMonth = m;
      }
    }

    return { grid, monthLabels };
  }, [globalStats.dailyUsage, tokenCount]);

  // Compute streaks
  const streakInfo = useMemo(() => {
    const dates = Object.keys(globalStats.dailyUsage).sort();
    if (dates.length === 0) {
      return { activeDays: 1, totalDays: 1, currentStreak: 1, longestStreak: 1 };
    }

    const todayStr = new Date().toISOString().split("T")[0]!;
    if (!dates.includes(todayStr)) {
      dates.push(todayStr);
    }

    const usageDatesSet = new Set(dates);
    const firstDate = new Date(dates[0]!);
    const totalDays = Math.max(1, Math.ceil((Date.now() - firstDate.getTime()) / (1000 * 60 * 60 * 24)));
    const activeDays = usageDatesSet.size;

    let longest = 0;
    let current = 0;
    let iterDate = new Date(firstDate);
    const end = new Date();

    while (iterDate <= end) {
      const dateStr = iterDate.toISOString().split("T")[0]!;
      if (usageDatesSet.has(dateStr)) {
        current++;
        if (current > longest) longest = current;
      } else {
        current = 0;
      }
      iterDate.setDate(iterDate.getDate() + 1);
    }

    // Current streak ending today or yesterday
    let currentStreak = 0;
    const checkDate = new Date();
    let checkDateStr = checkDate.toISOString().split("T")[0]!;
    if (usageDatesSet.has(checkDateStr)) {
      while (usageDatesSet.has(checkDateStr)) {
        currentStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
        checkDateStr = checkDate.toISOString().split("T")[0]!;
      }
    } else {
      checkDate.setDate(checkDate.getDate() - 1); // yesterday
      checkDateStr = checkDate.toISOString().split("T")[0]!;
      while (usageDatesSet.has(checkDateStr)) {
        currentStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
        checkDateStr = checkDate.toISOString().split("T")[0]!;
      }
    }

    return {
      activeDays,
      totalDays,
      currentStreak: Math.max(1, currentStreak),
      longestStreak: Math.max(1, longest),
    };
  }, [globalStats.dailyUsage]);

  const totalTokensVal = useMemo(() => {
    let sum = tokenCount;
    globalStats.sessions.forEach((s) => {
      if (s.id === sessionId) return;
      sum += s.tokens.input + s.tokens.output;
    });
    return sum;
  }, [globalStats, tokenCount, sessionId]);

  const lotrRatio = (totalTokensVal / 650000).toFixed(1);

  const termWidth = process.stdout.columns || 80;
  const dividerLine = "─".repeat(termWidth);

  // Mask sensitive key details
  const displayKey = activeApiKey
    ? activeApiKey.startsWith("sk-")
      ? `${activeApiKey.slice(0, 10)}…${activeApiKey.slice(-4)}`
      : "CONFIGURED"
    : "NOT_SET";

  return (
    <Box flexDirection="column" width="100%" paddingX={1} marginY={0}>
      <Text color="gray">{dividerLine}</Text>
      
      {/* Tab bar header */}
      <Box flexDirection="row" paddingBottom={1} paddingLeft={2}>
        {TABS.map((t) => {
          const active = activeTab === t.id;
          return (
            <Box key={t.id} marginRight={3}>
              <Text bold={active} color={active ? "cyan" : "gray"}>
                {t.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Settings Tab */}
      {activeTab === "settings" && (
        <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
          <Text bold color="white">Session</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text><Text color="gray">  Total cost:            </Text><Text bold>${totals.totalCost.toFixed(2)}</Text><Text dimColor> (costs may be inaccurate due to usage of unknown models)</Text></Text>
            <Text><Text color="gray">  Total duration (API):  </Text><Text bold>{formatDuration(totals.totalApiMs)}</Text></Text>
            <Text><Text color="gray">  Total duration (wall): </Text><Text bold>{formatDuration(totals.totalWallMs)}</Text></Text>
            <Text><Text color="gray">  Total code changes:    </Text><Text bold>{totals.totalLinesAdded} lines added, {totals.totalLinesRemoved} lines removed</Text></Text>
            
            <Box marginTop={1}><Text color="white" bold>Usage by model:</Text></Box>
            {Object.entries(totals.modelTotals).map(([m, usage]) => (
              <Text key={m}>
                <Text color="cyan">    {m.padEnd(20)}: </Text>
                <Text bold>{(usage.input / 1000).toFixed(1)}k</Text><Text dimColor> input, </Text>
                <Text bold>{(usage.output / 1000).toFixed(1)}k</Text><Text dimColor> output, </Text>
                <Text bold>{(usage.cacheRead / 1000).toFixed(1)}k</Text><Text dimColor> cache read, </Text>
                <Text bold>{(usage.cacheWrite / 1000).toFixed(1)}k</Text><Text dimColor> cache write </Text>
                <Text bold color="green">(${usage.cost.toFixed(2)})</Text>
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {/* Status Tab */}
      {activeTab === "status" && (
        <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
          <Box flexDirection="column">
            <Text><Text color="gray">  Version:             </Text><Text bold>0.1.0</Text></Text>
            <Text><Text color="gray">  Session name:        </Text><Text bold>{sessionId}</Text></Text>
            <Text><Text color="gray">  Session ID:          </Text><Text color="cyan">{sessionId}</Text></Text>
            <Text><Text color="gray">  cwd:                 </Text><Text color="cyan">{workingDirectory}</Text></Text>
            <Text><Text color="gray">  Auth token:          </Text><Text color="yellow">{displayKey}</Text></Text>
            <Text><Text color="gray">  Base URL:            </Text><Text color="cyan">{activeBaseURL || "https://api.deepseek.com/v1"}</Text></Text>
            
            <Box marginTop={1} flexDirection="column">
              <Text><Text color="gray">  Model:               </Text><Text bold color="green">{activeModel}</Text></Text>
              <Text><Text color="gray">  MCP servers:         </Text><Text bold color="green">{mcpCount} connected</Text><Text dimColor> · /mcp</Text></Text>
              <Text><Text color="gray">  Setting sources:     </Text><Text bold>User settings, Environment variables, Config files</Text></Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Config Tab */}
      {activeTab === "config" && (
        <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
          <Text bold color="white">Configuration Sources</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">  Active settings profile:   <Text bold color="green">{activeProvider}/{activeModel}</Text></Text>
            <Text color="gray">  Max tool steps per turn:   <Text bold>25</Text></Text>
            <Text color="gray">  Dangerously skip prompts:  <Text color={config.dangerouslySkipPermissions ? "red" : "green"}>{config.dangerouslySkipPermissions ? "Yes" : "No"}</Text></Text>
            
            <Box marginTop={1}><Text bold color="white">Configuration Files Loaded:</Text></Box>
            <Text color="cyan">  1. Project local: <Text color="white">{join(workingDirectory, ".deepseek-code.json")} {existsSync(join(workingDirectory, ".deepseek-code.json")) ? "✓ found" : "· missing"}</Text></Text>
            <Text color="cyan">  2. User global:    <Text color="white">~/.deepseek-code/settings.json ✓ loaded</Text></Text>
          </Box>
        </Box>
      )}

      {/* Usage Tab */}
      {activeTab === "usage" && (
        <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
          <Text bold color="white">Session Usage</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text><Text color="gray">  Total cost:            </Text><Text bold>${totals.totalCost.toFixed(2)}</Text></Text>
            <Text><Text color="gray">  Total duration (API):  </Text><Text bold>{formatDuration(totals.totalApiMs)}</Text></Text>
            <Text><Text color="gray">  Total duration (wall): </Text><Text bold>{formatDuration(totals.totalWallMs)}</Text></Text>
            <Text><Text color="gray">  Total code changes:    </Text><Text bold>{totals.totalLinesAdded} lines added, {totals.totalLinesRemoved} lines removed</Text></Text>
          </Box>
        </Box>
      )}

      {/* Stats Tab */}
      {activeTab === "stats" && (
        <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
          {/* Sub-header tabs for stats overview/models */}
          <Box flexDirection="row" marginBottom={1}>
            <Box marginRight={3}>
              <Text bold={statsView === "overview"} color={statsView === "overview" ? "white" : "gray"}>
                Overview
              </Text>
            </Box>
            <Box>
              <Text bold={statsView === "models"} color={statsView === "models" ? "white" : "gray"}>
                Models
              </Text>
            </Box>
          </Box>

          {statsView === "overview" ? (
            <Box flexDirection="column">
              {/* Heatmap header: Months */}
              <Box paddingLeft={6} height={1}>
                <Text color="gray">
                  {heatmapGrid.monthLabels.map((lbl, idx) => (
                    <React.Fragment key={idx}>
                      {lbl.padEnd(2)}
                    </React.Fragment>
                  ))}
                </Text>
              </Box>

              {/* Heatmap rows */}
              {heatmapGrid.grid.map((row, rIdx) => {
                let dayLabel = "   ";
                if (rIdx === 1) dayLabel = "Mon";
                if (rIdx === 3) dayLabel = "Wed";
                if (rIdx === 5) dayLabel = "Fri";

                return (
                  <Box key={rIdx} flexDirection="row">
                    <Box width={5} marginRight={1}>
                      <Text color="gray">{dayLabel}</Text>
                    </Box>
                    <Text>
                      {row.map((char, cIdx) => {
                        let color = "gray";
                        if (char === "░") color = "green";
                        if (char === "▒") color = "yellow";
                        if (char === "▓") color = "orange";
                        if (char === "█") color = "red";
                        return (
                          <Text key={cIdx} color={color}>
                            {char} 
                          </Text>
                        );
                      })}
                    </Text>
                  </Box>
                );
              })}

              {/* Heatmap Legend */}
              <Box paddingLeft={6} marginTop={1}>
                <Text dimColor>Less </Text>
                <Text color="gray">· </Text>
                <Text color="green">░ </Text>
                <Text color="yellow">▒ </Text>
                <Text color="orange">▓ </Text>
                <Text color="red">█ </Text>
                <Text dimColor>More</Text>
              </Box>

              {/* Stats indicators */}
              <Box flexDirection="column" marginTop={1}>
                <Text><Text color="gray">  Favorite model: </Text><Text bold color="cyan">{activeModel}</Text><Text color="gray">         Total tokens: </Text><Text bold color="white">{(totalTokensVal / 1000000).toFixed(1)}m</Text></Text>
                <Text><Text color="gray">  Sessions:       </Text><Text bold>{totals.totalSessionsCount}</Text><Text color="gray">                    Longest session: </Text><Text bold>{formatDuration(totals.totalWallMs)}</Text></Text>
                <Text><Text color="gray">  Active days:    </Text><Text bold>{streakInfo.activeDays}/{streakInfo.totalDays}</Text><Text color="gray">               Longest streak:  </Text><Text bold>{streakInfo.longestStreak} days</Text></Text>
                <Text><Text color="gray">  Most active day:</Text><Text bold>Today</Text><Text color="gray">                  Current streak:  </Text><Text bold>{streakInfo.currentStreak} days</Text></Text>
                
                <Box marginTop={1}>
                  <Text color="magenta" italic>
                    You've used ~{lotrRatio}x more tokens than The Lord of the Rings
                  </Text>
                </Box>
              </Box>
            </Box>
          ) : (
            /* Models breakdown view */
            <Box flexDirection="column">
              <Text bold color="white">Models Token Usage Breakdown</Text>
              <Box flexDirection="column" marginTop={1}>
                {Object.entries(totals.modelTotals).map(([m, usage]) => (
                  <Box key={m} flexDirection="column" marginBottom={1}>
                    <Text color="cyan" bold>{m}</Text>
                    <Text color="gray">  - Input tokens:        <Text bold color="white">{usage.input.toLocaleString()}</Text></Text>
                    <Text color="gray">  - Output tokens:       <Text bold color="white">{usage.output.toLocaleString()}</Text></Text>
                    <Text color="gray">  - Cached read tokens:  <Text bold color="white">{usage.cacheRead.toLocaleString()}</Text></Text>
                    <Text color="gray">  - Cost incurred:       <Text bold color="green">${usage.cost.toFixed(4)}</Text></Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

          <Box marginTop={1}>
            <Text dimColor>↓ stats/view · r to refresh · ctrl+s to copy stats</Text>
          </Box>
        </Box>
      )}

      {/* Footer controls instruction */}
      <Box paddingLeft={2} marginTop={1} marginBottom={0}>
        <Text dimColor>Esc to cancel · ←→ switch tabs</Text>
      </Box>
      <Text color="gray">{dividerLine}</Text>
    </Box>
  );
}
