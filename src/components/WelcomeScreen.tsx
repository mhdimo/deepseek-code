/**
 * The transcript's empty state — Deepy beside the reference's three dim lines
 * (LogoV2/CondensedLogo.tsx, which the reference draws in its own full logo
 * too): product + version, the model and where it posts, and where you are,
 * with the prompt below as the only thing asking. The boxed welcome this
 * replaces carried a READY chip, a quick-start list and a feature list; the
 * header is those three lines and nothing else.
 *
 * The mascot is the animated whale rather than the three-glyph header sprite:
 * the sprite was a stand-in for a header three rows tall, and Deepy is the
 * one thing at startup worth the rows.
 */
import React, { useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import { basename } from "path";
import { getTheme, getThemeMode, resolveColor, type Theme } from "../utils/theme.js";
import {
  DEEPY_BLUE,
  deepyTruecolor,
  deepyWhaleFrame,
  deepyWhaleSolid,
  packDeepyFrame,
  useDeepyFrame,
} from "./deepyMascot.js";
import { DEEPY_IDLE } from "./deepyWhale.js";

/** Column gap between the mascot and the text block (the reference's `gap={2}`). */
const GAP = 2;

/** Slack kept clear at the right edge so a full-width line never touches it. */
const RIGHT_PADDING = 1;

/** Breathing room off the left edge — the whale's outline starts at column 0
 *  in the sprite, and flush against the terminal wall it reads as clipped. */
const LEFT_MARGIN = 2;

/** The sprite's column count — its widest row, measured once off the pixel
 *  data (the truecolor rows carry SGR, so their string length is not width). */
const SPRITE_WIDTH = Math.max(
  ...DEEPY_IDLE.flatMap((frame) =>
    packDeepyFrame(frame.rows).map((cells) => cells.length),
  ),
);

interface WelcomeScreenProps {
  version: string;
  model: string;
  workingDirectory: string;
  agentName: string;
  baseURL?: string;
  hasApiKey?: boolean;
  /** Pin the mascot's first frame — for a welcome parked behind an overlay. */
  frozen?: boolean;
}

/**
 * The one part of the base URL worth a header row: `https://host/v1` -> `host`.
 * Absent a custom endpoint this is the provider's own host (registry.ts).
 */
function endpointHost(baseURL: string | undefined): string {
  const host = (baseURL ?? "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, "");
  return host || "api.deepseek.com";
}

export default function WelcomeScreen({
  version,
  model,
  workingDirectory,
  agentName,
  baseURL,
  hasApiKey = true,
  frozen = false,
}: WelcomeScreenProps) {
  const theme: Theme = getTheme(getThemeMode() === "light" ? "light" : "dark");
  const color = (token: keyof Theme): string => resolveColor(theme[token]!);

  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  const frame = DEEPY_IDLE[useDeepyFrame(!frozen)]!;
  // The sprite carries its own 24-bit palette where the terminal can render
  // it; otherwise it is a silhouette in the body blue.
  const whaleRows = deepyTruecolor() ? deepyWhaleFrame(frame) : deepyWhaleSolid(frame);
  // The text block gets what the mascot, the gap and the right edge leave.
  // 20 columns is the reference's floor, below which it stops truncating.
  const textWidth = Math.max(columns - LEFT_MARGIN - SPRITE_WIDTH - GAP - RIGHT_PADDING, 20);

  const cwdDisplay = useMemo(() => {
    if (!workingDirectory) return "~";
    const home = process.env.HOME;
    if (home && workingDirectory.startsWith(home)) {
      const tail = workingDirectory.slice(home.length);
      return `~${tail || "/"}`;
    }
    return `~/${basename(workingDirectory)}`;
  }, [workingDirectory]);

  return (
    <Box flexDirection="column" marginLeft={LEFT_MARGIN} marginBottom={1}>
      <Box flexDirection="row" gap={GAP} alignItems="center">
        <Box flexDirection="column">
          {whaleRows.map((row, i) => (
            // Truecolor rows carry their own SGR; the solid fallback is a
            // plain silhouette the Text colors.
            <Text key={i} color={deepyTruecolor() ? undefined : DEEPY_BLUE}>
              {row}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" width={textWidth}>
          <Text wrap="truncate-end">
            <Text bold color={color("claude")}>
              DeepSeek Code
            </Text>
            <Text dimColor> v{version}</Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {model} · {endpointHost(baseURL)}
          </Text>
          <Text dimColor wrap="truncate-end">
            @{agentName} · {cwdDisplay}
          </Text>
        </Box>
      </Box>

      {/* The reference has no key-less state — auth is built into it. Ours is
          one dim line, not the banner the boxed welcome used, and only when
          there is nothing to talk to yet. */}
      {!hasApiKey && (
        <Box marginTop={1}>
          <Text wrap="truncate-end">
            <Text color={color("error")}>No API key</Text>
            <Text dimColor> — paste one below, or grab one at </Text>
            <Text color={color("claude")}>platform.deepseek.com/api_keys</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
