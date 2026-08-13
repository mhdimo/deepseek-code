












import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { Tabs, Tab, useTabHeaderFocus } from "../../ui/design-system/Tabs.js";
import { listSessions, type SessionData } from "../../state/storage.js";
import { theme, resolveColor } from "../../utils/theme.js";
import { formatTokenCount } from "../../services/tokenTracker.js";



export type StatsDateRange = "all" | "7d" | "30d";

export interface ModelUsageRow {
  model: string;
  sessions: number;
  tokens: number;
}

export interface StatsAggregate {
  
  sessions: number;
  
  totalTokens: number;
  
  totalDurationMs: number;
  
  longestSessionMs: number;
  
  favoriteModel: string | null;
  
  models: ModelUsageRow[];
  
  activeDays: number;
  
  rangeDays: number;
  
  longestStreak: number;
  
  currentStreak: number;
  
  mostActiveDay: string | null;
  
  dailySessions: Record<string, number>;
}

const DAY_MS = 86400000;


function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}


function localMidnightMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}


function dayOrdinal(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

function parseDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}


export function computeStats(
  sessions: SessionData[],
  range: StatsDateRange,
  now: Date = new Date(),
): StatsAggregate {
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  
  const nowMs = now.getTime();
  const todayStartMs = nowDay.getTime();
  const todayOrd = dayOrdinal(nowDay);

  
  const startMs =
    range === "7d"
      ? todayStartMs - 6 * DAY_MS
      : range === "30d"
        ? todayStartMs - 29 * DAY_MS
        : 0;

  
  const dayCounts = new Map<string, number>();
  const dayOrds = new Map<string, number>();
  const modelMap = new Map<string, ModelUsageRow>();
  
  const allDayCounts = new Map<string, number>();
  let totalTokens = 0;
  let totalDurationMs = 0;
  let longestSessionMs = 0;
  let earliestOrd = Infinity;

  for (const s of sessions) {
    if (!Number.isFinite(s.createdAt)) continue;
    const created = new Date(s.createdAt);
    const dayKey = localDayKey(created);
    allDayCounts.set(dayKey, (allDayCounts.get(dayKey) ?? 0) + 1);

    if (s.createdAt < startMs || s.createdAt > nowMs) continue;

    const ord = dayOrdinal(created);
    if (ord < earliestOrd) earliestOrd = ord;
    dayCounts.set(dayKey, (dayCounts.get(dayKey) ?? 0) + 1);
    if (!dayOrds.has(dayKey)) dayOrds.set(dayKey, ord);

    if (Number.isFinite(s.tokenUsage) && s.tokenUsage > 0) {
      totalTokens += s.tokenUsage;
    }
    const duration =
      Number.isFinite(s.updatedAt)
        ? Math.max(0, s.updatedAt - s.createdAt)
        : 0;
    totalDurationMs += duration;
    if (duration > longestSessionMs) longestSessionMs = duration;

    const row = modelMap.get(s.model) ?? { model: s.model, sessions: 0, tokens: 0 };
    row.sessions += 1;
    if (Number.isFinite(s.tokenUsage) && s.tokenUsage > 0) {
      row.tokens += s.tokenUsage;
    }
    modelMap.set(s.model, row);
  }

  
  const activeOrds = new Set(dayOrds.values());
  let currentStreak = 0;
  for (let ord = todayOrd; activeOrds.has(ord); ord--) currentStreak++;

  const sortedOrds = [...activeOrds].sort((a, b) => a - b);
  let longestStreak = 0;
  let run = 0;
  let prev = Infinity;
  for (const ord of sortedOrds) {
    run = ord === prev + 1 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = ord;
  }

  
  let mostActiveDay: string | null = null;
  let busiestCount = 0;
  let busiestOrd = Infinity;
  for (const [key, count] of dayCounts) {
    const ord = dayOrds.get(key)!;
    if (count > busiestCount || (count === busiestCount && ord < busiestOrd)) {
      mostActiveDay = key;
      busiestCount = count;
      busiestOrd = ord;
    }
  }

  const models = [...modelMap.values()].sort(
    (a, b) =>
      b.tokens - a.tokens ||
      b.sessions - a.sessions ||
      (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
  );

  const rangeDays =
    range === "7d" ? 7 : range === "30d" ? 30 : earliestOrd === Infinity ? 1 : todayOrd - earliestOrd + 1;

  const dailySessions: Record<string, number> = {};
  for (const [key, count] of allDayCounts) dailySessions[key] = count;

  return {
    sessions: dayCounts.size > 0 ? [...dayCounts.values()].reduce((a, b) => a + b, 0) : 0,
    totalTokens,
    totalDurationMs,
    longestSessionMs,
    favoriteModel: models.length > 0 ? models[0]!.model : null,
    models,
    activeDays: dayCounts.size,
    rangeDays,
    longestStreak,
    currentStreak,
    mostActiveDay,
    dailySessions,
  };
}



export interface HeatmapGrid {
  weeks: number;
  
  monthLabels: Array<{ label: string; week: number }>;
  
  cells: number[][];
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];


export function buildHeatmap(
  dailySessions: Record<string, number>,
  columns: number = 80,
): HeatmapGrid {
  
  
  const maxWeeks = Math.min(52, Math.max(10, columns - 6));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const currentWeekStart = new Date(today);
  currentWeekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  
  
  
  const roughStart = new Date(currentWeekStart);
  roughStart.setDate(roughStart.getDate() - (maxWeeks - 1) * 7);
  const start = new Date(roughStart.getFullYear(), roughStart.getMonth() + 1, 1);
  
  const spanWeeks = Math.ceil((today.getTime() - start.getTime()) / (7 * 86400000)) + 1;
  const weeks = Math.min(maxWeeks, Math.max(10, spanWeeks));

  
  const counts = new Map<string, number>();
  const values: number[] = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const key = localDayKey(cursor);
    const n = dailySessions[key] ?? 0;
    counts.set(key, n);
    if (n > 0) values.push(n);
    cursor.setDate(cursor.getDate() + 1);
  }
  values.sort((a, b) => a - b);
  const p25 = values.length > 0 ? values[Math.floor(values.length * 0.25)]! : 0;
  const p50 = values.length > 0 ? values[Math.floor(values.length * 0.5)]! : 0;
  const p75 = values.length > 0 ? values[Math.floor(values.length * 0.75)]! : 0;

  const cells: number[][] = Array.from({ length: 7 }, () => Array(weeks).fill(0));
  const monthLabels: Array<{ label: string; week: number }> = [];
  let lastMonth = -1;

  const gridCursor = new Date(start);
  for (let week = 0; week < weeks; week++) {
    for (let day = 0; day < 7; day++) {
      if (gridCursor > today) {
        cells[day]![week] = -1;
        gridCursor.setDate(gridCursor.getDate() + 1);
        continue;
      }
      
      if (day === 0) {
        const month = gridCursor.getMonth();
        if (month !== lastMonth) {
          monthLabels.push({ label: MONTH_NAMES[month]!, week });
          lastMonth = month;
        }
      }
      const n = counts.get(localDayKey(gridCursor)) ?? 0;
      cells[day]![week] = n === 0 ? 0 : n >= p75 ? 4 : n >= p50 ? 3 : n >= p25 ? 2 : 1;
      gridCursor.setDate(gridCursor.getDate() + 1);
    }
  }

  return { weeks, monthLabels, cells };
}


function buildMonthLabelLine(grid: HeatmapGrid): string {
  const line = new Array<string>(4 + grid.weeks).fill(" ");
  let lastEnd = -3; 
  for (const { label, week } of grid.monthLabels) {
    const pos = 4 + week;
    if (pos < lastEnd + 1) continue; 
    for (let i = 0; i < label.length; i++) {
      if (pos + i < line.length) line[pos + i] = label[i]!;
    }
    lastEnd = pos + label.length;
  }
  return line.join("");
}




export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDay(key: string): string {
  return parseDayKey(key).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}



const BOOK_COMPARISONS = [
  { name: "The Great Gatsby", tokens: 62000 },
  { name: "The Hobbit", tokens: 123000 },
  { name: "Dune", tokens: 244000 },
  { name: "Les Misérables", tokens: 689000 },
  { name: "War and Peace", tokens: 730000 },
];

const SLEEP_MINUTES = 480;

export function generateFunFactoid(agg: StatsAggregate): string {
  const factoids: string[] = [];

  const longestMinutes = agg.longestSessionMs / 60000;
  if (longestMinutes >= 2 * SLEEP_MINUTES) {
    factoids.push(
      `Your longest session is ~${Math.floor(longestMinutes / SLEEP_MINUTES)}x longer than a full night of sleep`,
    );
  }

  if (agg.totalTokens > 0) {
    const book = [...BOOK_COMPARISONS]
      .reverse()
      .find((b) => agg.totalTokens >= b.tokens);
    if (book) {
      const times = agg.totalTokens / book.tokens;
      factoids.push(
        times >= 2
          ? `You've used ~${Math.floor(times)}x more tokens than ${book.name}`
          : `You've used the same number of tokens as ${book.name}`,
      );
    }
  }

  if (agg.totalDurationMs > 0) {
    factoids.push(`All your sessions together lasted ${formatDuration(agg.totalDurationMs)}`);
  }

  if (agg.activeDays > 0) {
    factoids.push(`You were active on ${agg.activeDays} of the last ${agg.rangeDays} days`);
  }

  if (factoids.length === 0) return "";
  return factoids[Math.floor(Math.random() * factoids.length)]!;
}



const DATE_RANGE_LABELS: Record<StatsDateRange, string> = {
  all: "All time",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};
const DATE_RANGE_ORDER: StatsDateRange[] = ["all", "7d", "30d"];

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const GLYPHS = ["·", "░", "▒", "▓", "█"];

export type StatsProps = {
  
  sessions?: SessionData[];
};

export function Stats({ sessions: sessionsProp }: StatsProps = {}): React.ReactNode {
  const sessions = useMemo(() => sessionsProp ?? listSessions(), [sessionsProp]);
  const [range, setRange] = useState<StatsDateRange>("all");
  const [innerTab, setInnerTab] = useState<"Overview" | "Models">("Overview");
  const { stdout } = useStdout();
  
  
  const { headerFocused: outerHeaderFocused, focusHeader } = useTabHeaderFocus();
  const agg = useMemo(() => computeStats(sessions, range), [sessions, range]);
  const factoid = useMemo(() => generateFunFactoid(agg), [agg]);

  
  
  useInput(
    (_input, key) => {
      if (key.rightArrow || key.tab) {
        setInnerTab((prev) => (prev === "Overview" ? "Models" : "Overview"));
      } else if (key.leftArrow || (key.tab && key.shift)) {
        setInnerTab((prev) => (prev === "Models" ? "Overview" : "Models"));
      } else if (key.upArrow) {
        focusHeader();
      }
    },
    { isActive: !outerHeaderFocused },
  );

  
  useInput(
    (input, key) => {
      if (input === "r" && !key.ctrl && !key.meta) {
        const i = DATE_RANGE_ORDER.indexOf(range);
        setRange(DATE_RANGE_ORDER[(i + 1) % DATE_RANGE_ORDER.length]!);
      }
    },
    { isActive: true },
  );

  if (sessions.length === 0) {
    return (
      <Box marginTop={1}>
        <Text dimColor>No stats available yet — start a session to see analytics.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Tabs
          color="claude"
          defaultTab="Overview"
          selectedTab={innerTab}
          onTabChange={(tab) => setInnerTab(tab === "Models" ? "Models" : "Overview")}
          disableNavigation
          initialHeaderFocused={false}
        >
          <Tab title="Overview">
            <OverviewTab agg={agg} factoid={factoid} range={range} columns={stdout.columns ?? 80} />
          </Tab>
          <Tab title="Models">
            <ModelsTab agg={agg} range={range} />
          </Tab>
        </Tabs>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>r to cycle dates · Esc cancel</Text>
      </Box>
    </Box>
  );
}

function DateRangeSelector({ range }: { range: StatsDateRange }): React.ReactNode {
  const blue = resolveColor(theme.claude);
  return (
    <Box marginBottom={1}>
      <Text>
        {DATE_RANGE_ORDER.map((r, i) => (
          <Text key={r}>
            {i > 0 && <Text dimColor>{" · "}</Text>}
            {r === range ? (
              <Text bold color={blue}>
                {DATE_RANGE_LABELS[r]}
              </Text>
            ) : (
              <Text dimColor>{DATE_RANGE_LABELS[r]}</Text>
            )}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function OverviewTab({
  agg,
  factoid,
  range,
  columns,
}: {
  agg: StatsAggregate;
  factoid: string;
  range: StatsDateRange;
  columns: number;
}): React.ReactNode {
  const blue = resolveColor(theme.claude);
  const muted = resolveColor(theme.inactive);
  const grid = useMemo(
    () => buildHeatmap(agg.dailySessions, columns),
    [agg.dailySessions, columns],
  );
  const dayWord = (n: number) => (n === 1 ? "day" : "days");

  return (
    <Box flexDirection="column" marginTop={1}>
      {}
      <Box flexDirection="column" marginBottom={1}>
        <Text>{buildMonthLabelLine(grid)}</Text>
        {grid.cells.map((row, day) => (
          <Text key={day}>
            {`${DAY_LABELS[day]} `}
            {row.map((intensity, week) => {
              if (intensity === -1) return <Text key={week}>{" "}</Text>;
              if (intensity === 0) {
                return (
                  <Text key={week} color={muted}>
                    {"·"}
                  </Text>
                );
              }
              return (
                <Text key={week} color={blue}>
                  {GLYPHS[intensity]!}
                </Text>
              );
            })}
          </Text>
        ))}
        <Text>
          {"    Less "}
          <Text color={blue}>{"░ ▒ ▓ █"}</Text>
          {" More"}
        </Text>
      </Box>

      {}
      <DateRangeSelector range={range} />

      {}
      <Box flexDirection="row" gap={4} marginBottom={1}>
        <Box flexDirection="column" width={28}>
          {agg.favoriteModel && (
            <Text wrap="truncate">
              {"Favorite model: "}
              <Text color={blue} bold>
                {agg.favoriteModel}
              </Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            {"Total tokens: "}
            <Text color={blue}>{formatTokenCount(agg.totalTokens)}</Text>
          </Text>
        </Box>
      </Box>

      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            {"Sessions: "}
            <Text color={blue}>{String(agg.sessions)}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            {"Longest session: "}
            <Text color={blue}>{formatDuration(agg.longestSessionMs)}</Text>
          </Text>
        </Box>
      </Box>

      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            {"Active days: "}
            <Text color={blue}>{String(agg.activeDays)}</Text>
            <Text dimColor>{`/${agg.rangeDays}`}</Text>
          </Text>
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            {"Longest streak: "}
            <Text color={blue} bold>
              {String(agg.longestStreak)}
            </Text>
            {" "}
            {dayWord(agg.longestStreak)}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={28}>
          {agg.mostActiveDay && (
            <Text wrap="truncate">
              {"Most active day: "}
              <Text color={blue}>{formatDay(agg.mostActiveDay)}</Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="column" width={28}>
          <Text wrap="truncate">
            {"Current streak: "}
            <Text color={blue} bold>
              {String(agg.currentStreak)}
            </Text>
            {" "}
            {dayWord(agg.currentStreak)}
          </Text>
        </Box>
      </Box>

      {}
      {factoid && (
        <Box marginTop={1}>
          <Text dimColor italic>
            {factoid}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function ModelsTab({
  agg,
  range,
}: {
  agg: StatsAggregate;
  range: StatsDateRange;
}): React.ReactNode {
  const blue = resolveColor(theme.success);
  return (
    <Box flexDirection="column" marginTop={1}>
      <DateRangeSelector range={range} />
      {agg.models.length === 0 ? (
        <Text dimColor>No model usage data available</Text>
      ) : (
        <Box flexDirection="column">
          {agg.models.map((row) => (
            <Text key={row.model}>
              <Text color={blue}>{"• "}</Text>
              <Text bold>{row.model}</Text>
              <Text dimColor>
                {" · "}
                {row.sessions} session{row.sessions === 1 ? "" : "s"} ·{" "}
                {formatTokenCount(row.tokens)} tokens
              </Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
