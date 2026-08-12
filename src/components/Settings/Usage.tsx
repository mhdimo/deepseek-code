// Usage — analytics pane. Ported from claude-code-main/src/components/Settings/Usage.tsx.
//
// The reference pane renders LimitBar sections — bold title, a ProgressBar
// (fillColor/emptyColor tokens, fixed width 50), the value text, and a dim
// subtext line — fed by Anthropic's utilization API. DeepSeek Code has no
// such API, so this port feeds the SAME LimitBar visual language from the
// on-disk session store (no props — durable analytics live in the session
// files). The aggregation is exported as aggregateUsage(sessions) so it can
// be probed with fixture data.

import React from "react";
import { Box, Text } from "ink";
import { getTheme, getThemeMode, resolveColor, type Theme } from "../../utils/theme.js";
import { ProgressBar } from "../../ui/design-system/ProgressBar.js";
import { listSessions, type SessionData } from "../../state/storage.js";
import { formatTokenCount } from "../../services/tokenTracker.js";

/** How many days the activity bar covers. */
export const ACTIVITY_DAYS = 14;
/** DeepSeek context window (deepseek-chat default). */
const CONTEXT_WINDOW = 1_000_000;
/** Blended DeepSeek price estimate per 1M tokens (matches the status bar). */
const PRICE_PER_MILLION = 0.27;

export interface UsageAggregate {
  totalSessions: number;
  totalTokens: number;
  totalMessages: number;
  /** Sum of wall-clock session durations (updatedAt - createdAt), ms. */
  totalApiDurationMs: number;
  modelCount: number;
  activeDays: number;
  peakDay: { date: Date; count: number } | null;
  /** Sessions per day, oldest first, aligned to end at today. */
  dailySessions: Array<{ date: Date; count: number }>;
  recentSessions: SessionData[];
}

function localDayKey(d: Date): string {
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

/** Aggregate raw persisted sessions into the analytics this pane renders.
 *  Pure over its input — probe with fixtures, safe to call with []. */
export function aggregateUsage(sessions: SessionData[]): UsageAggregate {
  let totalTokens = 0;
  let totalMessages = 0;
  let totalApiDurationMs = 0;
  const models = new Set<string>();

  for (const s of sessions) {
    if (Number.isFinite(s.tokenUsage)) totalTokens += s.tokenUsage;
    if (Array.isArray(s.messages)) totalMessages += s.messages.length;
    if (Number.isFinite(s.updatedAt) && Number.isFinite(s.createdAt)) {
      totalApiDurationMs += Math.max(0, s.updatedAt - s.createdAt);
    }
    if (typeof s.model === "string" && s.model) models.add(s.model);
  }

  const dayCounts = new Map<string, number>();
  for (const s of sessions) {
    if (!Number.isFinite(s.createdAt)) continue;
    const key = localDayKey(new Date(s.createdAt));
    dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
  }

  const now = new Date();
  const dailySessions: Array<{ date: Date; count: number }> = [];
  for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    dailySessions.push({ date: d, count: dayCounts.get(localDayKey(d)) ?? 0 });
  }

  const activeDays = dailySessions.reduce((n, d) => n + (d.count > 0 ? 1 : 0), 0);
  let peakDay: { date: Date; count: number } | null = null;
  for (const d of dailySessions) {
    if (peakDay === null || d.count > peakDay.count) peakDay = d;
  }
  if (peakDay !== null && peakDay.count === 0) peakDay = null;

  const recentSessions = [...sessions]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);

  return {
    totalSessions: sessions.length,
    totalTokens,
    totalMessages,
    totalApiDurationMs,
    modelCount: models.size,
    activeDays,
    peakDay,
    dailySessions,
    recentSessions,
  };
}

// ─── LimitBar (the reference Usage pane's section shape) ─────────────────────

interface LimitBarProps {
  title: string;
  ratio: number; // [0, 1]
  valueText: string;
  subtext?: string;
  fillColor?: keyof Theme;
  emptyColor?: keyof Theme;
}

/** Ported from the reference's LimitBar: bold title, then one row of
 *  [ProgressBar width=50][value], then a dim subtext line. */
function LimitBar({ title, ratio, valueText, subtext, fillColor = "success", emptyColor = "inactive" }: LimitBarProps): React.ReactElement {
  const theme = getTheme(getThemeMode() === "light" ? "light" : "dark");
  const color = (token: keyof Theme): string => resolveColor(theme[token]);
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <Box flexDirection="column">
      <Text bold color={color("text")}>
        {title}
      </Text>
      <Box flexDirection="row" gap={1}>
        <ProgressBar ratio={clamped} width={50} fillColor={fillColor} emptyColor={emptyColor} />
        <Text color={color("text")}>{valueText}</Text>
      </Box>
      {subtext ? <Text dimColor>{subtext}</Text> : null}
    </Box>
  );
}

// ─── Pane ────────────────────────────────────────────────────────────────────

export function Usage(): React.ReactNode {
  const sessions = listSessions();
  const aggregate = aggregateUsage(sessions);
  const theme = getTheme(getThemeMode() === "light" ? "light" : "dark");
  const color = (token: keyof Theme): string => resolveColor(theme[token]);

  if (aggregate.totalSessions === 0) {
    return (
      <Box flexDirection="column" width="100%" alignItems="center" marginTop={1}>
        <Text dimColor>No usage data yet — start a session to see analytics.</Text>
      </Box>
    );
  }

  const lastSessionTokens = aggregate.recentSessions[0]?.tokenUsage ?? 0;
  const ctxRatio = Math.min(1, lastSessionTokens / CONTEXT_WINDOW);
  const totalTokensRatio = Math.min(1, aggregate.totalTokens / 5_000_000);
  const avgTokens = aggregate.totalSessions > 0 ? Math.round(aggregate.totalTokens / aggregate.totalSessions) : 0;
  const spend = (aggregate.totalTokens / 1_000_000) * PRICE_PER_MILLION;
  const spendRatio = Math.min(1, spend / 10);
  const activityRatio = Math.min(1, aggregate.activeDays / ACTIVITY_DAYS);

  const peak = aggregate.peakDay;
  const peakLabel = peak
    ? `most active ${peak.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} (${peak.count} sessions)`
    : undefined;

  return (
    <Box flexDirection="column" gap={1} width="100%">
      <LimitBar
        title="Context window"
        ratio={ctxRatio}
        valueText={`${Math.round(ctxRatio * 100)}% used`}
        subtext={`${formatTokenCount(lastSessionTokens)} / 1M tokens in the most recent session · /clear resets it`}
      />
      <LimitBar
        title="All-time tokens"
        ratio={totalTokensRatio}
        valueText={formatTokenCount(aggregate.totalTokens)}
        subtext={`${aggregate.totalSessions} sessions · avg ${formatTokenCount(avgTokens)}/session · ${aggregate.modelCount} model${aggregate.modelCount === 1 ? "" : "s"} · ${aggregate.totalMessages} messages`}
      />
      <LimitBar
        title="Estimated spend"
        ratio={spendRatio}
        valueText={`$${spend.toFixed(2)}`}
        subtext="blended DeepSeek pricing estimate"
        fillColor="claude"
      />
      <LimitBar
        title="Activity"
        ratio={activityRatio}
        valueText={`${aggregate.activeDays}/${ACTIVITY_DAYS} days`}
        subtext={peakLabel}
        fillColor="warning"
        emptyColor="inactive"
      />

      <Text bold color={color("text")}>
        Recent sessions
      </Text>
      {aggregate.recentSessions.map((s, i) => {
        const date = Number.isFinite(s.createdAt)
          ? new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
            " at " +
            new Date(s.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          : "unknown";
        return (
          <Box key={`session-${i}`} flexDirection="row">
            <Text dimColor>{date.padEnd(20)}</Text>
            <Text>
              {s.model || "unknown"} · {formatTokenCount(s.tokenUsage ?? 0)} · {s.workingDirectory}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
