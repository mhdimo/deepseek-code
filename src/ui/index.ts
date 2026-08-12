// src/ui/index.ts — barrel export for the ported design system.
// (The canonical theme module stays at src/utils/theme.ts — do not re-export
// it from here; import getTheme/Theme directly from "../../utils/theme.js".)

export {
  ThemeProvider,
  useTheme,
  useThemeSetting,
  usePreviewTheme,
} from "./design-system/ThemeProvider.js";
export type {
  ThemeContextValue,
  ThemeProviderProps,
} from "./design-system/ThemeProvider.js";

export { default as ThemedText, TextHoverColorContext } from "./design-system/ThemedText.js";
export type { Props as ThemedTextProps } from "./design-system/ThemedText.js";

export { default as ThemedBox } from "./design-system/ThemedBox.js";
export type { Props as ThemedBoxProps } from "./design-system/ThemedBox.js";

export { Divider } from "./design-system/Divider.js";
export type { DividerProps } from "./design-system/Divider.js";

export { StatusIcon } from "./design-system/StatusIcon.js";
export type { StatusIconProps } from "./design-system/StatusIcon.js";

export { ProgressBar } from "./design-system/ProgressBar.js";
export type { ProgressBarProps } from "./design-system/ProgressBar.js";
