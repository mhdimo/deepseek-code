







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
  
  themeSetting: ThemeSetting;
  setThemeSetting: (setting: ThemeSetting) => void;
  setPreviewTheme: (setting: ThemeSetting) => void;
  savePreview: () => void;
  cancelPreview: () => void;
  
  currentTheme: ThemeName;
};


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


function applyThemeMode(themeName: ThemeName): void {
  syncLiveTheme(themeName);
}


function defaultInitialTheme(): ThemeSetting {
  return getThemeMode();
}

export function ThemeProvider({ children, initialState, onThemeSave }: ThemeProviderProps) {
  const [themeSetting, setThemeSettingState] = useState<ThemeSetting>(
    initialState ?? defaultInitialTheme,
  );
  const [previewTheme, setPreviewThemeState] = useState<ThemeSetting | null>(null);

  
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
          
          applyThemeMode(resolveThemeSetting(themeSetting));
        }
      },
      currentTheme,
    }),
    [themeSetting, previewTheme, currentTheme, onThemeSave],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}


export function useTheme(): [ThemeName, (setting: ThemeSetting) => void] {
  const { currentTheme, setThemeSetting } = useContext(ThemeContext);
  return [currentTheme, setThemeSetting];
}


export function useThemeSetting(): ThemeSetting {
  return useContext(ThemeContext).themeSetting;
}


export function usePreviewTheme(): {
  setPreviewTheme: (setting: ThemeSetting) => void;
  savePreview: () => void;
  cancelPreview: () => void;
} {
  const { setPreviewTheme, savePreview, cancelPreview } = useContext(ThemeContext);
  return { setPreviewTheme, savePreview, cancelPreview };
}
