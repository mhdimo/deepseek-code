












import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { getTheme, getThemeMode, resolveColor, type Theme } from "../../utils/theme.js";
import { ProgressBar } from "../../ui/design-system/ProgressBar.js";
import { listSessions, type SessionData } from "../../state/storage.js";
import { formatTokenCount } from "../../services/tokenTracker.js";


const CONTEXT_WINDOW = 1_000_000;

const SPEND_BAR_SCALE = 10;

const PRICE_PER_MILLION = 0.27;

export interface UsageAggregate {
  totalSessions: number;
  totalTokens: number;
  
  lastSessionTokens: number;
  
  spend: number;
}

function localDayKey(d: Date): string {
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}


export function aggregateUsage(sessions: SessionData[]): UsageAggregate {
  let totalTokens = 0;
  let lastSessionTokens = 0;
  let newest: SessionData | null = null;

  for (const s of sessions) {
    if (!Number.isFinite(s.tokenUsage)) continue;
    totalTokens += s.tokenUsage;
    if (Number.isFinite(s.createdAt) && (newest === null || s.createdAt > newest.createdAt)) {
      newest = s;
    }
  }
  lastSessionTokens = newest?.tokenUsage ?? 0;

  return {
    totalSessions: sessions.length,
    totalTokens,
    lastSessionTokens,
    spend: (totalTokens / 1_000_000) * PRICE_PER_MILLION,
  };
}



interface LimitBarProps {
  title: string;
  
  utilization: number;
  
  subtext?: string;
}


function LimitBar({ title, utilization, subtext }: LimitBarProps): React.ReactElement {
  const theme = getTheme(getThemeMode() === "light" ? "light" : "dark");
  const color = (token: keyof Theme): string => resolveColor(theme[token]);
  const usedText = `${Math.floor(utilization)}% used`;
  const fullSubtext = subtext ? `Resets ${subtext}` : undefined;
  return (
    <Box flexDirection="column">
      <Text bold color={color("text")}>
        {title}
      </Text>
      <Box flexDirection="row" gap={1}>
        <ProgressBar
          ratio={Math.max(0, Math.min(1, utilization / 100))}
          width={50}
          fillColor="rate_limit_fill"
          emptyColor="rate_limit_empty"
        />
        <Text color={color("text")}>{usedText}</Text>
      </Box>
      {fullSubtext ? <Text dimColor>{fullSubtext}</Text> : null}
    </Box>
  );
}



export function Usage(): React.ReactNode {
  
  
  const [sessions] = useState(() => listSessions());
  const aggregate = useMemo(() => aggregateUsage(sessions), [sessions]);

  if (aggregate.totalSessions === 0) {
    return (
      <Box flexDirection="column" width="100%" alignItems="center" marginTop={1}>
        <Text dimColor>No usage data yet — start a session to see analytics.</Text>
      </Box>
    );
  }

  const sessionUtil = Math.min(100, (aggregate.lastSessionTokens / CONTEXT_WINDOW) * 100);
  const spendUtil = Math.min(100, (aggregate.spend / SPEND_BAR_SCALE) * 100);

  return (
    <Box flexDirection="column" gap={1} width="100%">
      <LimitBar
        title="Current session"
        utilization={sessionUtil}
        subtext={`${formatTokenCount(aggregate.lastSessionTokens)} / 1M tokens · with /clear`}
      />
      <LimitBar
        title="Spend"
        utilization={spendUtil}
        subtext={`$${aggregate.spend.toFixed(2)} spent (${formatTokenCount(aggregate.totalTokens)} all-time tokens) · API billing`}
      />
      <Text dimColor>Esc cancel</Text>
    </Box>
  );
}
