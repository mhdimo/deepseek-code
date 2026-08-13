






import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme, resolveColor } from "../utils/theme.js";
import type { EffortLevel } from "../state/storage.js";

const AUTO_DISMISS_MS = 30_000;



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
  
  onDone: (selection: EffortLevel | "dismiss") => void;
  
  currentLevel?: EffortLevel;
}


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
    return idx >= 0 ? idx : 1; 
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
