import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import type { EffortLevel } from "../state/storage.js";

const AUTO_DISMISS_MS = 30_000;

/** Reference getOpusDefaultEffortConfig().dialogTitle, adapted: there is no
 *  Opus here, so the title is the recommendation itself. */
const DIALOG_TITLE = "We recommend medium effort";

/** Reference dialogDescription: "Claude" reads "the model" and the
 *  "maximize rate limits" clause (subscription copy) is dropped; the
 *  ultrathink sentence is live in this app too (utils/thinkingKeywords.ts). */
const DIALOG_DESCRIPTION =
  "Effort determines how long the model thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence. Use ultrathink to trigger high effort when needed.";


const EFFORT_SYMBOLS: Record<string, string> = {
  low: "○",
  medium: "◐",
  high: "●",
  xhigh: "◈",
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

  onDone: (selection: EffortLevel | "dismiss") => void;

  currentLevel?: EffortLevel;
}


/** Reference Select options: the recommended middle tier first, then the
 *  remaining tiers with the weakest last. DeepSeek's xhigh/max are real
 *  selectable levels, so they keep their slots before Low. */
const EFFORT_OPTIONS = [
  { label: "Medium (recommended)", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra high", value: "xhigh" },
  { label: "Max", value: "max" },
  { label: "Low", value: "low" },
] as const;

export default function EffortCallout({ onDone, currentLevel }: EffortCalloutProps) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;


  const handleCancel = useCallback(() => onDoneRef.current("dismiss"), []);
  useEffect(() => {
    const timeoutId = setTimeout(handleCancel, AUTO_DISMISS_MS);
    return () => clearTimeout(timeoutId);
  }, [handleCancel]);

  const handleSelect = (value: string) => {
    onDoneRef.current(value as EffortLevel);
  };

  // Reference chrome: PermissionDialog (top rule only + title row + content
  // box) wrapping the callout body, not a four-sided bordered box.
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={resolveColor(theme.permission)}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      marginTop={1}
      flexShrink={0}
    >
      <Box paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color={resolveColor(theme.permission)}>{DIALOG_TITLE}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Box marginBottom={1} flexDirection="column">
            <Text>{DIALOG_DESCRIPTION}</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>
              <EffortIndicatorSymbol level="low" /> low {"·"}{" "}
              <EffortIndicatorSymbol level="medium" /> medium {"·"}{" "}
              <EffortIndicatorSymbol level="high" /> high
            </Text>
          </Box>
          <VerticalSelect
            options={EFFORT_OPTIONS}
            onChange={handleSelect}
            onCancel={handleCancel}
            defaultValue={currentLevel && currentLevel !== "off" ? currentLevel : "medium"}
          />
        </Box>
      </Box>
    </Box>
  );
}


/** Stacked option list — the reference feeds these rows to its vertical
 *  Select (❯ marks the focused row), not the old horizontal run. */
function VerticalSelect({
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
    return idx >= 0 ? idx : 0;
  });

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (key.return) {
      onChange(options[selectedIndex]!.value);
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((option, i) => (
        <Text key={option.value}>
          <Text
            color={i === selectedIndex ? claude : undefined}
            bold={i === selectedIndex}
            dimColor={i !== selectedIndex}
          >
            {i === selectedIndex ? "❯ " : "  "}
            <EffortOptionLabel level={option.value} text={option.label} />
          </Text>
        </Text>
      ))}
    </Box>
  );
}
