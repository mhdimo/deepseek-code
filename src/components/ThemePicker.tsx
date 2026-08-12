// ThemePicker — ported from claude-code-main/src/components/ThemePicker.tsx.
//
// Interactive theme selection: intro/title + help, a Select over all seven
// theme options (arrows preview the theme live via setPreviewTheme, Enter
// commits with savePreview, Esc cancels), and the demo diff in a dashed
// border box. Used by the first-time onboarding AND the /theme command.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { StructuredPatchHunk } from "diff";
import { theme, resolveColor, type ThemeSetting } from "../utils/theme.js";
import { usePreviewTheme } from "../ui/design-system/ThemeProvider.js";
import { StructuredDiff } from "./StructuredDiff.js";

/** Demo diff rendered below the options — verbatim from the reference
 *  ThemePicker, with DeepSeek wording. */
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
  /** Esc (reference: cancelPreview, then gracefulShutdown/skip). */
  onCancel: () => void;
  /** Onboarding shows "Let's get started."; /theme shows a bold "Theme". */
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

  // Reference: Enter → savePreview() then onThemeSelect(setting).
  const handleChange = (setting: string) => {
    savePreview();
    onThemeSelect(setting as ThemeSetting);
  };
  // Reference: Esc → cancelPreview(), then cancel (skipExitHandling path).
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
      {/* Dashed border box (the reference uses borderStyle="dashed"; stock
          ink has no dashed style, so the ┄┄ lines are drawn manually). The
          diff renders its own "N " gutter inside `width`, so give it 3 fewer
          columns than the terminal to avoid overflowing the row. */}
      <Box flexDirection="column">
        <Text color={resolveColor(theme.subtle)}>{"┄".repeat(diffWidth)}</Text>
        <StructuredDiff patch={DEMO_PATCH} dim={false} width={diffWidth} />
        <Text color={resolveColor(theme.subtle)}>{"┄".repeat(diffWidth)}</Text>
      </Box>
    </Box>
  );
}
