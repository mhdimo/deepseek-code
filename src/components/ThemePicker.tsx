






import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { StructuredPatchHunk } from "diff";
import { theme, resolveColor, type ThemeSetting } from "../utils/theme.js";
import { usePreviewTheme } from "../ui/design-system/ThemeProvider.js";
import { StructuredDiff } from "./StructuredDiff.js";


const DEMO_PATCH: StructuredPatchHunk = {
  oldStart: 1,
  newStart: 1,
  oldLines: 3,
  newLines: 3,
  lines: [
    ' function greet() {',
    '-  console.log("Hello, World!");',
    '+  console.log("Hello, DeepSeek!");',
    ' }',
  ],
};

const THEME_OPTIONS = [
  { label: "Auto (match terminal)", value: "auto" },
  { label: "Dark mode", value: "dark" },
  { label: "Light mode", value: "light" },
  { label: "Dark mode (colorblind-friendly)", value: "dark-daltonized" },
  { label: "Light mode (colorblind-friendly)", value: "light-daltonized" },
  { label: "Dark mode (ANSI colors only)", value: "dark-ansi" },
  { label: "Light mode (ANSI colors only)", value: "light-ansi" },
] as const;

export interface ThemePickerProps {
  onThemeSelect: (setting: ThemeSetting) => void;
  
  onCancel: () => void;
  
  showIntroText?: boolean;
  helpText?: string;
  initialTheme?: ThemeSetting;
}

function Select({
  options,
  onChange,
  onCancel,
  onPreview,
  defaultValue,
}: {
  options: ReadonlyArray<{ label: string; value: string }>;
  onChange: (value: string) => void;
  onCancel: () => void;
  onPreview?: (value: string) => void;
  defaultValue?: string;
}): React.ReactElement {
  const claude = resolveColor(theme.claude);
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = options.findIndex((o) => o.value === defaultValue);
    return idx >= 0 ? idx : 0;
  });

  const moveTo = (i: number) => {
    const next = Math.max(0, Math.min(options.length - 1, i));
    setSelectedIndex(next);
    onPreview?.(options[next]!.value);
  };

  useInput((_input, key) => {
    if (key.upArrow) {
      moveTo(selectedIndex - 1);
    } else if (key.downArrow) {
      moveTo(selectedIndex + 1);
    } else if (key.return) {
      onChange(options[selectedIndex]!.value);
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((option, i) => (
        <Box key={option.value}>
          <Text color={i === selectedIndex ? claude : undefined} bold={i === selectedIndex}>
            {i === selectedIndex ? "› " : "  "}
            {option.label}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export default function ThemePicker({
  onThemeSelect,
  onCancel,
  showIntroText = false,
  helpText,
  initialTheme = "dark",
}: ThemePickerProps) {
  const { setPreviewTheme, savePreview, cancelPreview } = usePreviewTheme();

  
  const handleChange = (setting: string) => {
    savePreview();
    onThemeSelect(setting as ThemeSetting);
  };
  
  const handleCancel = () => {
    cancelPreview();
    onCancel();
  };

  const diffWidth = Math.max(20, (process.stdout.columns || 80) - 3);

  return (
    <Box flexDirection="column" gap={1}>
      {showIntroText ? (
        <Text>Let&apos;s get started.</Text>
      ) : (
        <Text bold color={resolveColor(theme.permission)}>
          Theme
        </Text>
      )}
      <Box flexDirection="column">
        <Text bold>Choose the text style that looks best with your terminal</Text>
        {helpText && <Text dimColor>{helpText}</Text>}
      </Box>
      <Select
        options={THEME_OPTIONS}
        onChange={handleChange}
        onCancel={handleCancel}
        onPreview={(value) => setPreviewTheme(value as ThemeSetting)}
        defaultValue={initialTheme}
      />
      {}
      <Box flexDirection="column">
        <Text color={resolveColor(theme.subtle)}>{"┄".repeat(diffWidth)}</Text>
        <StructuredDiff patch={DEMO_PATCH} dim={false} width={diffWidth} />
        <Text color={resolveColor(theme.subtle)}>{"┄".repeat(diffWidth)}</Text>
      </Box>
    </Box>
  );
}
