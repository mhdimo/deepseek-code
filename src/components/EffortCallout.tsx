// EffortCallout — ported from claude-code-main/src/components/EffortCallout.tsx.
//
// The interactive effort selector: a bordered dialog with the recommendation
// text, the symbol legend (◯ low · ◐ medium · ● high, in the suggestion
// color), and a Select (Medium (recommended) / High / Low). Auto-dismisses
// after 30s like the reference; Esc/30s → "dismiss" without changing.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import type { EffortLevel } from "../state/storage.js";

const AUTO_DISMISS_MS = 30_000;

// Effort symbols ported from the reference figures (EffortIndicator.ts):
// EFFORT_LOW '○' / EFFORT_MEDIUM '◐' / EFFORT_HIGH '●' / EFFORT_MAX '◉'
const EFFORT_SYMBOLS: Record<string, string> = {
  low: "○",
  medium: "◐",
  high: "●",
  max: "◉",
};

function EffortIndicatorSymbol({ level }: { level: string }): React.ReactElement {
  return <Text color={resolveColor(theme.suggestion)}>{EFFORT_SYMBOLS[level] ?? "●"}</Text>;
}

function EffortOptionLabel({ level, text }: { level: string; text: string }): React.ReactNode {
  return (
    <Text>
      <EffortIndicatorSymbol level={level} /> {text}
    </Text>
  );
}

interface EffortCalloutProps {
  /** Called with the picked level, or "dismiss" (Esc / 30s timeout). */
  onDone: (selection: EffortLevel | "dismiss") => void;
  /** Current level — pre-selects it (unset/"off" → medium). */
  currentLevel?: EffortLevel;
}

// Effort options in ascending order (the Claude Code effort picker order).
const EFFORT_OPTIONS = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra high", value: "xhigh" },
  { label: "Max", value: "max" },
] as const;

export default function EffortCallout({ onDone, currentLevel }: EffortCalloutProps) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // Reference behavior: auto-dismiss after 30s.
  const handleCancel = useCallback(() => onDoneRef.current("dismiss"), []);
  useEffect(() => {
    const timeoutId = setTimeout(handleCancel, AUTO_DISMISS_MS);
    return () => clearTimeout(timeoutId);
  }, [handleCancel]);

  const handleSelect = (value: string) => {
    onDoneRef.current(value as EffortLevel);
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={resolveColor(theme.permission)}
      paddingX={2}
      paddingY={1}
    >
      <Text>We recommend medium effort</Text>
      <Box marginBottom={1} flexDirection="column">
        <Text>
          Effort determines how long the model thinks for when completing your task. We
          recommend medium effort for most tasks to balance speed and intelligence. Use
          high or max when you need deeper reasoning.
        </Text>
      </Box>
      <HorizontalSelect
        options={EFFORT_OPTIONS}
        onChange={handleSelect}
        onCancel={handleCancel}
        defaultValue={currentLevel && currentLevel !== "off" ? currentLevel : "medium"}
      />
    </Box>
  );
}

/** Horizontal selector — options in one row, ←/→ move the highlight, Enter
 *  picks, Esc cancels. Each option shows its effort symbol in the suggestion
 *  color; the selected one gets the › cursor, brand color and bold. */
function HorizontalSelect({
  options,
  onChange,
  onCancel,
  defaultValue,
}: {
  options: ReadonlyArray<{ label: string; value: string }>;
  onChange: (value: string) => void;
  onCancel: () => void;
  defaultValue?: string;
}): React.ReactElement {
  const claude = resolveColor(theme.claude);
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = options.findIndex((o) => o.value === defaultValue);
    return idx >= 0 ? idx : 1; // default: Medium
  });

  useInput((_input, key) => {
    if (key.leftArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.rightArrow) {
      setSelectedIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (key.return) {
      onChange(options[selectedIndex]!.value);
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box>
      {options.map((option, i) => (
        <Text key={option.value}>
          {i > 0 && "   "}
          <Text
            color={i === selectedIndex ? claude : undefined}
            bold={i === selectedIndex}
            dimColor={i !== selectedIndex}
          >
            {i === selectedIndex ? "› " : "  "}
            <EffortIndicatorSymbol level={option.value} />
            {" "}
            {option.label}
          </Text>
        </Text>
      ))}
    </Box>
  );
}
