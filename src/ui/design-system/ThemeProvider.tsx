// ThemeProvider — React context that resolves the active ThemeName and keeps
// the legacy mutable `theme` module state (src/utils/theme.ts) in sync.
//
// Ported from claude-code-main/src/components/design-system/ThemeProvider.tsx
// with the fork-ink/systemThemeWatcher bits trimmed: 'auto' resolves via
// $COLORFGBG at mount (getSystemThemeName), and setting/previewing a theme
// also calls setThemeMode() so `import { theme }` consumers see the palette.

import React, { createContext, useContext, useMemo, useState } from "react";
import {
  getSystemThemeName,
  getThemeMode,
  resolveThemeSetting,
  syncLiveTheme,
  type ThemeName,
  type ThemeSetting,
} from "../../utils/theme.js";

export type ThemeContextValue = {
  /** The saved user preference. May be 'auto'. */
  themeSetting: ThemeSetting;
  setThemeSetting: (setting: ThemeSetting) => void;
  setPreviewTheme: (setting: ThemeSetting) => void;
  savePreview: () => void;
  cancelPreview: () => void;
  /** The resolved theme to render with. Never 'auto'. */
  currentTheme: ThemeName;
};

// Non-'auto' default so useTheme() works without a provider (tests, tooling).
const DEFAULT_THEME: ThemeName = "dark";
const ThemeContext = createContext<ThemeContextValue>({
  themeSetting: DEFAULT_THEME,
  setThemeSetting: () => {},
  setPreviewTheme: () => {},
  savePreview: () => {},
  cancelPreview: () => {},
  currentTheme: DEFAULT_THEME,
});

export type ThemeProviderProps = {
  children: React.ReactNode;
  initialState?: ThemeSetting;
  onThemeSave?: (setting: ThemeSetting) => void;
};

/** Keep the live mutable `theme` object in sync with the resolved theme —
 *  including ANSI and daltonized variants (syncLiveTheme handles them). */
function applyThemeMode(themeName: ThemeName): void {
  syncLiveTheme(themeName);
}

/** Default preference follows the app's existing themeMode module state. */
function defaultInitialTheme(): ThemeSetting {
  return getThemeMode();
}

export function ThemeProvider({ children, initialState, onThemeSave }: ThemeProviderProps) {
  const [themeSetting, setThemeSettingState] = useState<ThemeSetting>(
    initialState ?? defaultInitialTheme,
  );
  const [previewTheme, setPreviewThemeState] = useState<ThemeSetting | null>(null);

  // The setting currently in effect (preview wins while picker is open)
  const activeSetting = previewTheme ?? themeSetting;
  const currentTheme: ThemeName = resolveThemeSetting(activeSetting);

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeSetting,
      setThemeSetting: (newSetting: ThemeSetting) => {
        setThemeSettingState(newSetting);
        setPreviewThemeState(null);
        applyThemeMode(resolveThemeSetting(newSetting));
        onThemeSave?.(newSetting);
      },
      setPreviewTheme: (newSetting: ThemeSetting) => {
        setPreviewThemeState(newSetting);
        applyThemeMode(resolveThemeSetting(newSetting));
      },
      savePreview: () => {
        if (previewTheme !== null) {
          setThemeSettingState(previewTheme);
          setPreviewThemeState(null);
          applyThemeMode(resolveThemeSetting(previewTheme));
          onThemeSave?.(previewTheme);
        }
      },
      cancelPreview: () => {
        if (previewTheme !== null) {
          setPreviewThemeState(null);
          // Restore the committed palette on the legacy mutable `theme` object.
          applyThemeMode(resolveThemeSetting(themeSetting));
        }
      },
      currentTheme,
    }),
    [themeSetting, previewTheme, currentTheme, onThemeSave],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Returns the resolved theme for rendering (never 'auto') and a setter that
 * accepts any ThemeSetting (including 'auto').
 */
export function useTheme(): [ThemeName, (setting: ThemeSetting) => void] {
  const { currentTheme, setThemeSetting } = useContext(ThemeContext);
  return [currentTheme, setThemeSetting];
}

/**
 * Returns the raw theme setting as stored in config. Use this in UI that
 * needs to show 'auto' as a distinct choice (e.g., a theme picker).
 */
export function useThemeSetting(): ThemeSetting {
  return useContext(ThemeContext).themeSetting;
}

/** Preview/save/cancel helpers for a theme picker overlay. */
export function usePreviewTheme(): {
  setPreviewTheme: (setting: ThemeSetting) => void;
  savePreview: () => void;
  cancelPreview: () => void;
} {
  const { setPreviewTheme, savePreview, cancelPreview } = useContext(ThemeContext);
  return { setPreviewTheme, savePreview, cancelPreview };
}
