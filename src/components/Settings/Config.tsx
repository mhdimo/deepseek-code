































import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import {
  loadSettings,
  saveSettings,
  type EffortLevel,
  type PersistedSettings,
} from "../../state/storage.js";
import { useTabHeaderFocus } from "../../ui/design-system/Tabs.js";
import {
  resolveColor,
  resolveThemeSetting,
  syncLiveTheme,
  theme,
  type ThemeSetting,
} from "../../utils/theme.js";

export interface ConfigProps {
  
  context?: unknown;
  
  onClose: () => void;
  
  setTabsHidden: (hidden: boolean) => void;
  
  onIsSearchModeChange?: (inSearchMode: boolean) => void;
  
  contentHeight?: number;
}



type SettingBase = {
  id: string;
  label: string;
  description: string;
};

type BooleanSetting = SettingBase & {
  type: "boolean";
  value: boolean;
  onChange: (value: boolean) => void;
};

type EnumSetting = SettingBase & {
  type: "enum";
  value: string;
  options: readonly string[];
  
  display?: (value: string) => string;
  onChange: (value: string) => void;
};

type TextSetting = SettingBase & {
  type: "text";
  
  value: string;
  
  editSeed: string;
  
  validate?: (value: string) => boolean;
  onChange: (value: string) => void;
};

type DisplaySetting = SettingBase & {
  type: "display";
  value: string;
};

type Setting = BooleanSetting | EnumSetting | TextSetting | DisplaySetting;


const THEME_LABELS: Record<string, string> = {
  auto: "Auto (match terminal)",
  dark: "Dark mode",
  light: "Light mode",
  "dark-daltonized": "Dark mode (colorblind-friendly)",
  "light-daltonized": "Light mode (colorblind-friendly)",
  "dark-ansi": "Dark mode (ANSI colors only)",
  "light-ansi": "Light mode (ANSI colors only)",
};

const EFFORT_OPTIONS = ["off", "low", "medium", "high", "max"] as const;
const AGENT_OPTIONS = ["code", "plan", "review"] as const;
const THINKING_OPTIONS = ["off", "whale"] as const;
const THEME_OPTIONS = ["auto", "dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi"] as const;


function maskApiKey(key: string | undefined): string {
  if (!key) return "not set";
  if (key.length <= 12) return `${key.slice(0, 4)}…${key.slice(-4)}`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}


function permissionSummary(p: PersistedSettings["permissions"]): string {
  const allow = p?.allow?.length ?? 0;
  const deny = p?.deny?.length ?? 0;
  const ask = p?.ask?.length ?? 0;
  if (allow + deny + ask === 0) return "no rules";
  return `allow ${allow} · deny ${deny} · ask ${ask}`;
}




function renderCursorText(
  text: string,
  offset: number,
  focused: boolean,
): React.ReactNode {
  if (!focused) {
    return <Text dimColor>{text}</Text>;
  }
  const before = text.slice(0, offset);
  const at = text[offset] ?? " ";
  const after = text.slice(offset + 1);
  return (
    <Text>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </Text>
  );
}



export default function Config({
  onClose,
  setTabsHidden,
  onIsSearchModeChange,
  contentHeight,
}: ConfigProps): React.ReactElement {
  
  
  
  const { headerFocused, focusHeader } = useTabHeaderFocus();
  const [settingsData, setSettingsData] = useState<PersistedSettings>(() => loadSettings());
  const [selectedIndex, setSelectedIndex] = useState(0);
  
  const [isSearchMode, setIsSearchMode] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  
  const [editSetting, setEditSetting] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  
  

  
  
  const claude = resolveColor(theme.claude);
  const suggestion = resolveColor(theme.suggestion);

  
  
  const persist = (partial: PersistedSettings): void => {
    saveSettings(partial);
    setSettingsData(loadSettings());
  };

  
  const settingsItems = useMemo<Setting[]>(() => {
    const s = settingsData;
    return [
      {
        id: "model",
        label: "Model",
        description:
          "Model used for new sessions — deepseek-chat, deepseek-reasoner, or a custom model",
        type: "text" as const,
        value: s.model || "deepseek-chat",
        editSeed: s.model ?? "",
        onChange: (v: string) => {
          const trimmed = v.trim();
          persist({ model: trimmed ? trimmed : undefined });
        },
      },
      {
        id: "effort",
        label: "Effort",
        description:
          "Reasoning effort for deepseek-reasoner: off sends nothing — the provider default applies",
        type: "enum" as const,
        value: s.effort ?? "off",
        options: EFFORT_OPTIONS,
        onChange: (v: string) => persist({ effort: v as EffortLevel }),
      },
      {
        id: "themeMode",
        label: "Theme",
        description:
          "Color theme — auto follows the terminal. Theme changes apply immediately",
        type: "enum" as const,
        value: s.themeMode ?? "auto",
        options: THEME_OPTIONS,
        display: (v: string) => THEME_LABELS[v] ?? v,
        onChange: (v: string) => {
          const setting = v as ThemeSetting;
          persist({ themeMode: setting });
          
          
          syncLiveTheme(resolveThemeSetting(setting));
        },
      },
      {
        id: "statusLine",
        label: "Status line",
        description:
          "Custom status bar command, set via /statusline — trust-gated, 5s timeout",
        type: "display" as const,
        value: s.statusLine ? `command: ${s.statusLine.command}` : "not set",
      },
      {
        id: "permissions",
        label: "Permissions",
        description:
          "Tool permission rules in allow/deny/ask form, set via /permissions or settings.json",
        type: "display" as const,
        value: permissionSummary(s.permissions),
      },
      {
        id: "apiKey",
        label: "API key",
        description:
          "DeepSeek API key — masked: first 8 + last 4 shown. Editing replaces the key",
        type: "text" as const,
        value: maskApiKey(s.apiKey),
        
        
        editSeed: "",
        onChange: (v: string) => {
          const trimmed = v.trim();
          persist({ apiKey: trimmed ? trimmed : undefined });
        },
      },
      {
        id: "provider",
        label: "Provider",
        description: "API provider profile used for requests",
        type: "text" as const,
        value: s.provider || "deepseek",
        editSeed: s.provider ?? "",
        onChange: (v: string) => {
          const trimmed = v.trim();
          persist({ provider: trimmed ? trimmed : undefined });
        },
      },
      {
        id: "baseURL",
        label: "Base URL",
        description: "API endpoint override, e.g. a proxy",
        type: "text" as const,
        value: s.baseURL || "https://api.deepseek.com/v1",
        editSeed: s.baseURL ?? "",
        onChange: (v: string) => {
          const trimmed = v.trim();
          persist({ baseURL: trimmed ? trimmed : undefined });
        },
      },
      {
        id: "defaultAgent",
        label: "Default agent",
        description: "Default agent for new sessions",
        type: "enum" as const,
        value: s.defaultAgent ?? "code",
        options: AGENT_OPTIONS,
        onChange: (v: string) => persist({ defaultAgent: v }),
      },
      {
        id: "thinkingMode",
        label: "Thinking mode",
        description: "Thinking mode preference — whale or off",
        type: "enum" as const,
        value: s.thinkingMode ?? "off",
        options: THINKING_OPTIONS,
        onChange: (v: string) => persist({ thinkingMode: v }),
      },
      {
        id: "outputStyle",
        label: "Output style",
        description: "Output style for assistant messages",
        type: "text" as const,
        value: s.outputStyle || "default",
        editSeed: s.outputStyle ?? "",
        onChange: (v: string) => {
          const trimmed = v.trim();
          persist({ outputStyle: trimmed ? trimmed : undefined });
        },
      },
      {
        id: "includeCoAuthoredBy",
        label: "Co-Authored-By",
        description: "Add a Co-Authored-By trailer to /commit messages",
        type: "boolean" as const,
        value: s.includeCoAuthoredBy ?? false,
        onChange: (v: boolean) => persist({ includeCoAuthoredBy: v }),
      },
      {
        id: "cleanupPeriodDays",
        label: "Cleanup period",
        description: "Delete saved sessions older than N days on startup",
        type: "text" as const,
        value: String(s.cleanupPeriodDays ?? 30),
        editSeed: String(s.cleanupPeriodDays ?? 30),
        validate: (v: string) => /^\d+$/.test(v.trim()),
        onChange: (v: string) => {
          const n = Number(v.trim());
          if (!Number.isInteger(n) || n < 0) return;
          persist({ cleanupPeriodDays: n });
        },
      },
      {
        id: "spinnerTipsEnabled",
        label: "Spinner tips",
        description: "Show the spinner tip / elapsed line",
        type: "boolean" as const,
        value: s.spinnerTipsEnabled ?? true,
        onChange: (v: boolean) => persist({ spinnerTipsEnabled: v }),
      },
      {
        id: "verbose",
        label: "Verbose output",
        description: "Verbose debug logging",
        type: "boolean" as const,
        value: s.verbose ?? false,
        onChange: (v: boolean) => persist({ verbose: v }),
      },
      {
        id: "env",
        label: "Env vars",
        description: "Environment variables injected into the session / tool environment",
        type: "display" as const,
        value: `${Object.keys(s.env ?? {}).length} variable(s) configured`,
      },
    ];
  }, [settingsData]);

  
  
  const filteredSettingsItems = useMemo(() => {
    const lowerQuery = searchQuery.trim().toLowerCase();
    if (!lowerQuery) return settingsItems;
    return settingsItems.filter((setting) => {
      if (setting.id.toLowerCase().includes(lowerQuery)) return true;
      if (setting.label.toLowerCase().includes(lowerQuery)) return true;
      return setting.description.toLowerCase().includes(lowerQuery);
    });
  }, [settingsItems, searchQuery]);

  
  useEffect(() => {
    if (selectedIndex >= filteredSettingsItems.length) {
      setSelectedIndex(Math.max(0, filteredSettingsItems.length - 1));
    }
  }, [filteredSettingsItems.length, selectedIndex]);

  
  
  
  
  useEffect(() => {
    setTabsHidden(editSetting !== null);
    return () => {
      setTabsHidden(false);
    };
  }, [editSetting, setTabsHidden]);

  
  
  
  
  const ownsEsc = isSearchMode && !headerFocused;
  useEffect(() => {
    onIsSearchModeChange?.(ownsEsc);
  }, [ownsEsc, onIsSearchModeChange]);

  

  const moveSelection = (delta: -1 | 1): void => {
    const newIndex = Math.max(
      0,
      Math.min(filteredSettingsItems.length - 1, selectedIndex + delta),
    );
    setSelectedIndex(newIndex);
  };

  
  
  const toggleSetting = (): void => {
    const setting = filteredSettingsItems[selectedIndex];
    if (!setting) return;
    if (setting.type === "boolean") {
      setting.onChange(!setting.value);
      return;
    }
    if (setting.type === "enum") {
      const currentIndex = setting.options.indexOf(setting.value);
      const next = setting.options[(currentIndex + 1) % setting.options.length];
      setting.onChange(next ?? setting.value);
      return;
    }
    if (setting.type === "text") {
      setEditSetting(setting.id);
      setEditValue(setting.editSeed);
      return;
    }
    
  };

  const commitEdit = (): void => {
    const setting = filteredSettingsItems.find((s) => s.id === editSetting);
    setEditSetting(null);
    if (!setting || setting.type !== "text") return;
    if (setting.validate && !setting.validate(editValue)) return;
    setting.onChange(editValue);
  };

  
  
  
  useInput((input: string, key: Key) => {
    
    if (editSetting !== null) {
      if (key.escape) {
        setEditSetting(null);
        return;
      }
      if (key.return) {
        commitEdit();
        return;
      }
      if (key.backspace || key.delete) {
        setEditValue((v) => v.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input.length > 0) {
        setEditValue((v) => v + input);
      }
      return;
    }

    
    
    
    if (headerFocused) return;

    
    if (isSearchMode) {
      if (key.escape) {
        if (searchQuery.length > 0) {
          setSearchQuery("");
          setCursorOffset(0);
        } else {
          setIsSearchMode(false);
        }
        return;
      }
      if (key.return || key.downArrow) {
        setIsSearchMode(false);
        setSelectedIndex(0); 
        return;
      }
      if (key.upArrow) {
        
        
        focusHeader();
        return;
      }
      if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          setSearchQuery((q) => q.slice(0, cursorOffset - 1) + q.slice(cursorOffset));
          setCursorOffset((c) => c - 1);
        }
        return;
      }
      if (key.leftArrow) {
        setCursorOffset((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursorOffset((c) => Math.min(searchQuery.length, c + 1));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input.length > 0) {
        setSearchQuery((q) => q.slice(0, cursorOffset) + input + q.slice(cursorOffset));
        setCursorOffset((c) => c + input.length);
      }
      return;
    }

    
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      if (selectedIndex === 0) {
        
        setIsSearchMode(true); 
        return;
      }
      moveSelection(-1);
      return;
    }
    if (key.downArrow) {
      moveSelection(1);
      return;
    }
    if (key.pageUp) {
      setSelectedIndex(0);
      return;
    }
    if (key.pageDown) {
      setSelectedIndex(filteredSettingsItems.length - 1);
      return;
    }
    
    
    if (
      key.return ||
      key.tab ||
      key.leftArrow ||
      key.rightArrow ||
      (!key.ctrl && !key.meta && input === " ")
    ) {
      toggleSetting();
      return;
    }
    if (key.ctrl || key.meta) return;
    
    
    if (input.length > 0) {
      setIsSearchMode(true);
      setSearchQuery(input);
      setCursorOffset(input.length);
    }
  });

  

  const editingSetting =
    editSetting !== null
      ? settingsItems.find((s) => s.id === editSetting)
      : undefined;

  const footer =
    editSetting !== null
      ? "Enter save · Esc cancel"
      : headerFocused
        ? "←/→ tab switch · ↓ return · Esc close"
        : isSearchMode
          ? "Type to filter · Enter/↓ select first · ↑ tabs · Esc clear"
          : "Enter/Space to change · / to search · Esc to close";

  return (
    <Box flexDirection="column" width="100%" paddingX={1} gap={1}>
      {}
      <Box
        flexDirection="row"
        borderStyle="round"
        borderColor={resolveColor(theme.promptBorder)}
        paddingX={1}
      >
        <Text color={claude} bold>
          {editSetting !== null ? "✎ " : "⌕ "}
        </Text>
        {editSetting !== null && editingSetting?.type === "text" ? (
          <>
            <Text dimColor>
              {`Edit ${editingSetting.label}: `}
            </Text>
            {renderCursorText(editValue, editValue.length, true)}
          </>
        ) : isSearchMode ? (
          searchQuery.length > 0 ? (
            renderCursorText(searchQuery, cursorOffset, true)
          ) : (
            <Text>
              {renderCursorText("", 0, true)}
              <Text dimColor>Search settings…</Text>
            </Text>
          )
        ) : (
          <Text dimColor>{searchQuery.length > 0 ? `"${searchQuery}"` : "Search settings…"}</Text>
        )}
      </Box>

      {}
      <Box flexDirection="column">
        {filteredSettingsItems.length === 0 ? (
          <Text dimColor italic>
            {`No settings match "${searchQuery}"`}
          </Text>
        ) : (
          <>
            {filteredSettingsItems
              .map((setting, i) => {
                const isSelected =
                  i === selectedIndex &&
                  !isSearchMode &&
                  editSetting === null;
                
                
                return (
                  <Box key={setting.id} flexDirection="row">
                    <Box width={50}>
                      <Text color={isSelected ? suggestion : undefined} bold={isSelected}>
                        {isSelected ? "❯ " : "  "}
                        {setting.label}
                      </Text>
                    </Box>
                    <Text color={isSelected ? suggestion : undefined}>
                      {setting.type === "boolean"
                        ? setting.value.toString()
                        : setting.type === "enum"
                          ? (setting.display?.(setting.value) ?? setting.value)
                          : setting.value}
                    </Text>
                  </Box>
                );
              })}
          </>
        )}
      </Box>

      <Text dimColor>{footer}</Text>
    </Box>
  );
}
