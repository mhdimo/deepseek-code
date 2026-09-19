






import React from "react";
import { Box, Text } from "ink";
import type { StructuredPatchHunk } from "diff";
import { theme, resolveColor, type ThemeSetting } from "../utils/theme.js";
import { usePreviewTheme } from "../ui/design-system/ThemeProvider.js";
import { Select } from "../ui/design-system/Select.js";
import { DASHED_BORDER, StructuredDiff } from "./StructuredDiff.js";


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

  const columns = process.stdout.columns || 80;
  // The demo preview fills the frame it sits in, and the frame fills the box
  // it is given — which is the whole terminal when /theme opens the picker,
  // and two columns narrower during onboarding, where Onboarding wraps this
  // component in a marginX={1} box. A preview wider than its container is not
  // merely clipped: ink wraps each row, and the wrap takes the row's +/- sigil
  // with it, so the preview has to be the width it actually has. (Same
  // subtraction the reference makes in FileWriteToolDiff, which passes
  // columns - 2 inside a paddingX={1} frame.)
  const demoWidth = showIntroText ? columns - 2 : columns;

  const content = (
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
        // All seven at once, as the reference does — the shared default (5)
        // would window them to five and add "and 2 more…".
        visibleOptionCount={THEME_OPTIONS.length}
      />
      {}
      <Box flexDirection="column" width="100%">
        <Box
          flexDirection="column"
          borderTop
          borderBottom
          borderLeft={false}
          borderRight={false}
          borderStyle={DASHED_BORDER}
          borderColor={resolveColor(theme.subtle)}
        >
          <StructuredDiff patch={DEMO_PATCH} dim={false} width={demoWidth} />
        </Box>
        {}
        <Text dimColor>
          {" "}
          Syntax highlighting is not available for diffs
        </Text>
      </Box>
    </Box>
  );


  if (!showIntroText) {
    return (
      <>
        <Box flexDirection="column">{content}</Box>
        <Box marginTop={1}>
          <Box>
            <Text dimColor italic>
              Enter to select · Esc to cancel
            </Text>
          </Box>
        </Box>
      </>
    );
  }

  return content;
}
