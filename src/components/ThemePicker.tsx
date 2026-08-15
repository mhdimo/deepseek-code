






import React from "react";
import { Box, Text } from "ink";
import type { StructuredPatchHunk } from "diff";
import { theme, resolveColor, type ThemeSetting } from "../utils/theme.js";
import { usePreviewTheme } from "../ui/design-system/ThemeProvider.js";
import { Select } from "../ui/design-system/Select.js";
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
        onFocus={(value) => setPreviewTheme(value as ThemeSetting)}
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
