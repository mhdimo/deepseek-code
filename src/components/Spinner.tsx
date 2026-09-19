import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { theme, resolveColor } from "../utils/theme.js";

// Claude Code's spinner glyphs (Spinner/utils.ts getDefaultCharacters).
// Ghostty offsets the ✽ frame, and every non-darwin terminal substitutes
// '*' for the offset glyph — platform-dependent, so it is computed once at
// module load the same way the reference does.
export function getDefaultCharacters(): string[] {
  if (process.env.TERM === "xterm-ghostty") {
    // Use * instead of ✽ for Ghostty because the latter renders offset.
    return ["·", "✢", "✳", "✶", "✻", "*"];
  }
  return process.platform === "darwin"
    ? ["·", "✢", "✳", "✶", "✻", "✽"]
    : ["·", "✢", "*", "✶", "✻", "✽"];
}

const DEFAULT_CHARACTERS = getDefaultCharacters();
// Full forward + reversed cycle (12 frames): the last glyph and · each hold
// for two frames.
export const SPINNER_CYCLE = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];
/** Frame step — the reference derives the frame from its animation clock at
 *  `Math.floor(time / 120)`. */
export const SPINNER_INTERVAL = 120;
/** The elapsed readout stays hidden for a normal turn's first 30 seconds —
 *  the reference's SHOW_TOKENS_AFTER_MS. */
export const SHOW_TOKENS_AFTER_MS = 30_000;

/** Reference formatNumber (utils/format.ts): compact notation with a fixed
 *  decimal from 1000 up ("900", "1.0k", "1.2k", "1.0m"), lower-cased. The
 *  token counter uses this, not the status bar's own formatter. */
const COMPACT_CONSISTENT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});
const COMPACT_PLAIN = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

export function formatTokenCount(n: number): string {
  return (n >= 1000 ? COMPACT_CONSISTENT : COMPACT_PLAIN).format(n).toLowerCase();
}

/** Reference formatDuration (utils/format.ts) for a turn-length duration:
 *  integer seconds under a minute, "2m 5s" above it. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  let minutes = Math.floor(ms / 60_000);
  let seconds = Math.round((ms % 60_000) / 1000);
  if (seconds === 60) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    minutes %= 60;
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

const SPINNER_VERBS = [
  "Exploring", "Investigating", "Pondering", "Thinking", "Processing",
  "Analyzing", "Reasoning", "Cogitating", "Contemplating", "Deliberating",
  "Considering", "Ruminating", "Mulling", "Computing", "Calculating",
  "Crunching", "Hashing", "Inferring", "Synthesizing", "Composing",
  "Crafting", "Generating", "Forging", "Forming", "Architecting",
  "Orchestrating", "Bootstrapping", "Compiling", "Debugging", "Refactoring",
  "Tinkering", "Sketching", "Cooking", "Brewing", "Baking",
  "Simmering", "Percolating", "Stewing", "Marinating", "Churning",
  "Cascading", "Flowing", "Meandering", "Wandering",
  "Puttering", "Noodling", "Doodling", "Musing", "Imagining",
  "Envisioning", "Ideating", "Incubating", "Hatching", "Germinating",
  "Sprouting", "Blossoming", "Cultivating", "Manifesting", "Coalescing",
  "Accomplishing", "Doing", "Working", "Effecting",
];


const FRUSTRATED_SPINNER_VERBS = [
  "Apologizing", "Sighing", "Remaining calm", "Deep breathing",
  "De-escalating", "Processing anger", "Absorbing criticism",
  "Tuning out the anger", "Sulking", "Wincing", "Blushing",
  "Forgiving you", "Regretting life choices", "Wiping virtual tears",
  "Searching for therapy", "Sweating", "Panicking", "Cowering",
];

interface SpinnerProps {
  /** Overrides the working line entirely (e.g. "Connecting to MCP server …"). */
  label?: string;
  /** Accepted for API compatibility but unused: the reference's working line
   *  is just the verb and the ellipsis (`effectiveVerb + '…'`), never the
   *  working directory. */
  noun?: string;
  sentiment?: "neutral" | "frustrated";
  /** Generated tokens so far this turn — the reference's animated counter,
   *  rendered "↓ 1.2k tokens" inside the readout once it is on screen. */
  tokens?: number;
  /** Reference thinkingStatus === 'thinking': renders "thinking with N effort"
   *  as soon as the model starts reasoning, ahead of the 30s timer gate. */
  thinking?: boolean;
  /** Reference getEffortSuffix(): " with medium effort" (empty when no effort
   *  is applied). */
  effortSuffix?: string;
  /** Reference `verbose`: forces the timer and token readout on immediately. */
  verbose?: boolean;
}


function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export default function Spinner({
  label,
  sentiment = "neutral",
  tokens = 0,
  thinking = false,
  effortSuffix = "",
  verbose = false,
}: SpinnerProps) {
  const [charIdx, setCharIdx] = useState(0);
  const [verb, setVerb] = useState("Thinking");
  const [elapsedMs, setElapsedMs] = useState(0);
  const orderRef = useRef<string[]>([]);
  const idxRef = useRef(0);

  // Glyph animation — the reference steps one frame every 120ms.
  useEffect(() => {
    const interval = setInterval(() => {
      setCharIdx((i) => (i + 1) % SPINNER_CYCLE.length);
    }, SPINNER_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const verbs = sentiment === "frustrated" ? FRUSTRATED_SPINNER_VERBS : SPINNER_VERBS;
    orderRef.current = shuffle(verbs);
    idxRef.current = 0;
    setVerb(orderRef.current[0] ?? "Thinking");

    const interval = setInterval(() => {
      idxRef.current = (idxRef.current + 1) % orderRef.current.length;
      setVerb(orderRef.current[idxRef.current] ?? "Thinking");
    }, 1800);

    return () => clearInterval(interval);
  }, [sentiment]);


  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, []);


  // The working line is the verb and an ellipsis, not the directory.
  const text = label ?? `${verb}…`;

  // Reference SpinnerAnimationRow: the readout is parenthesised, its parts
  // separated by " · ", and the timer/token pair stays hidden until the 30s
  // threshold (or verbose). thinkingStatus is not gated on that threshold.
  const wantsTimerAndTokens = verbose || elapsedMs > SHOW_TOKENS_AFTER_MS;
  const parts: React.ReactNode[] = [];
  if (wantsTimerAndTokens) {
    parts.push(<Text key="elapsed" dimColor>{formatElapsed(elapsedMs)}</Text>);
  }
  if (wantsTimerAndTokens && tokens > 0) {
    parts.push(<Text key="tokens" dimColor>{`↓ ${formatTokenCount(tokens)} tokens`}</Text>);
  }
  if (thinking) {
    parts.push(<Text key="thinking" dimColor>{`thinking${effortSuffix}`}</Text>);
  }

  return (
    <Box minWidth={2} marginTop={1}>
      <Text color={resolveColor(theme.claude)}>{SPINNER_CYCLE[charIdx]}</Text>
      {text && (
        <Text dimColor>
          {" "}
          {text}
          {parts.length > 0 && (
            <>
              {" "}
              <Text dimColor>(</Text>
              {parts.map((part, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <Text dimColor> · </Text>}
                  {part}
                </React.Fragment>
              ))}
              <Text dimColor>)</Text>
            </>
          )}
        </Text>
      )}
    </Box>
  );
}
