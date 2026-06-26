import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { theme } from "../utils/theme.js";

import { useBlink } from "./ToolBlock.js";

// The spinner glyph — a black circle that pulses (blinks) while the model is
// working, with a rotating verb beside it: "⏺ Pondering…".
const GLYPH = "⏺";

// Rotating "progress" verbs shown while the agent works. Cycled sequentially
// (shuffled once per run) so the same verb never repeats back-to-back.
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

// Shown when the user is frustrated/hostile — the agent "stays calm".
const FRUSTRATED_SPINNER_VERBS = [
  "Apologizing", "Sighing", "Remaining calm", "Deep breathing",
  "De-escalating", "Processing anger", "Absorbing criticism",
  "Tuning out the anger", "Sulking", "Wincing", "Blushing",
  "Forgiving you", "Regretting life choices", "Wiping virtual tears",
  "Searching for therapy", "Sweating", "Panicking", "Cowering",
];

interface SpinnerProps {
  /** Override the whole label (disables verb rotation). */
  label?: string;
  /** Object the verb acts on, e.g. the repo name → "✶ Exploring deepseek-code…". */
  noun?: string;
  sentiment?: "neutral" | "frustrated";
}

/** Fisher–Yates shuffle returning a new array. */
function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export default function Spinner({ label, noun, sentiment = "neutral" }: SpinnerProps) {
  const show = useBlink();
  const [verb, setVerb] = useState("Thinking");
  const [elapsed, setElapsed] = useState(0);
  const orderRef = useRef<string[]>([]);
  const idxRef = useRef(0);

  // Rotate through the (shuffled) verb list with no immediate repeats.
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

  // Live elapsed-seconds counter (resets each time the spinner mounts = each turn).
  useEffect(() => {
    setElapsed(0);
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // A custom label disables rotation entirely.
  const text = label ?? (noun ? `${verb} ${noun}…` : `${verb}…`);

  return (
    <Box minWidth={2}>
      <Text color={theme.assistant}>{show ? GLYPH : " "}</Text>
      {text && (
        <Text dimColor>
          {" "}
          {text} <Text color="gray">{elapsed}s</Text>
        </Text>
      )}
    </Box>
  );
}
