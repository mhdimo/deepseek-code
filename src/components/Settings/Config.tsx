// Config — the search-driven settings pane. Ported from
// claude-code-main/src/components/Settings/Config.tsx (the search UI over
// Claude's settings model), adapted to DeepSeek Code's PersistedSettings.
//
// UX (faithful to the reference):
//   - A search input row at the top. The pane opens in search mode; typing
//     fuzzy-filters settings by name/description. The search box has a
//     movable cursor (←/→), backspace/delete editing, Esc clears the query
//     then exits search, Enter/↓ leaves search and selects the first row,
//     ↑ hands focus to the tab row so ←/→ can switch tabs (reference
//     onExitUp: focusHeader — its footer hint is "↑ tabs").
//   - The filtered list of setting rows: name + current value on the first
//     line, dim description on the second. ↑/↓ navigate (↑ at the top of the
//     list re-enters search, matching the reference's boundary behavior);
//     the list pages through a visible window sized to `contentHeight`, with
//     "N more above/below" hints like the reference.
//   - Enter/Space/←/→/Tab on a row edits it: boolean → toggle, enum → cycle
//     the options, free-text → inline edit mode in the search row (type,
//     backspace, Enter commits, Esc cancels). Esc in list mode closes.
//   - Any printable character in list mode drops straight into search
//     (reference behavior), and '/' works the same way.
//
// Data model adaptation (ours, not theirs): settings come from
// PersistedSettings via loadSettings()/saveSettings() (src/state/storage.ts,
// both sync) — no OAuth/login/updater/betas/cloud settings. Theme changes
// additionally call syncLiveTheme(resolveThemeSetting(v)) so the live mutable
// `theme` object repaints; effort needs nothing extra (the session cache key
// covers it). The API key is masked (first 8 + last 4).
//
// Stock ink only — the reference's fork-ink Select/SearchBox are replaced by
// plain Box/Text + useInput cursor handling.

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
  /** Unused in this port (the reference's LocalJSXCommandContext). Ignored. */
  context?: unknown;
  /** Esc in list mode (and after search is cleared). The parent unmounts. */
  onClose: () => void;
  /** Hide the tab bar while the search input is focused / an edit is open. */
  setTabsHidden: (hidden: boolean) => void;
  /**
   * Report when Config's own Esc handler is active (search mode with content
   * focus) so the Settings shell cedes Esc — reference onIsSearchModeChange.
   */
  onIsSearchModeChange?: (inSearchMode: boolean) => void;
  /** Available pane height in rows (the parent's tab-pane height). */
  contentHeight?: number;
}

// ─── Setting model ──────────────────────────────────────────────────────────

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
  /** Optional value → display label (e.g. theme names). */
  display?: (value: string) => string;
  onChange: (value: string) => void;
};

type TextSetting = SettingBase & {
  type: "text";
  /** Display value (masked / defaulted). */
  value: string;
  /** Seed for the inline edit (empty = start blank, e.g. masked keys). */
  editSeed: string;
  /** Reject the edit if this returns false. */
  validate?: (value: string) => boolean;
  onChange: (value: string) => void;
};

type DisplaySetting = SettingBase & {
  type: "display";
  value: string;
};

type Setting = BooleanSetting | EnumSetting | TextSetting | DisplaySetting;

/** Theme option labels — verbatim from the reference Config.tsx. */
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

/** Mask an API key: first 8 + last 4 characters. */
function maskApiKey(key: string | undefined): string {
  if (!key) return "not set";
  if (key.length <= 12) return `${key.slice(0, 4)}…${key.slice(-4)}`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** Summary of the permission rule counts. */
function permissionSummary(p: PersistedSettings["permissions"]): string {
  const allow = p?.allow?.length ?? 0;
  const deny = p?.deny?.length ?? 0;
  const ask = p?.ask?.length ?? 0;
  if (allow + deny + ask === 0) return "no rules";
  return `allow ${allow} · deny ${deny} · ask ${ask}`;
}

// ─── Search-row cursor rendering ────────────────────────────────────────────

/**
 * Render text with an inverse block cursor at `offset`. Mirrors the
 * reference SearchBox's cursor handling (stock ink has no TextInput export
 * in 6.x, so the cursor is drawn manually).
 */
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

// ─── The pane ───────────────────────────────────────────────────────────────

export default function Config({
  onClose,
  setTabsHidden,
  onIsSearchModeChange,
  contentHeight,
}: ConfigProps): React.ReactElement {
  // Tab-header focus handoff (reference: useTabHeaderFocus). ↑ in search mode
  // focuses the header so ←/→ switch tabs; while it is focused this pane's
  // handler cedes all keys to the Tabs row, and ↓ returns focus to the list.
  const { headerFocused, focusHeader } = useTabHeaderFocus();
  const [settingsData, setSettingsData] = useState<PersistedSettings>(() => loadSettings());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  // The reference opens in search mode so typing filters immediately.
  const [isSearchMode, setIsSearchMode] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  // Inline edit of a free-text setting (id of the setting being edited).
  const [editSetting, setEditSetting] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Visible-window paging. contentHeight is set by the parent tab pane;
  // reserve ~6 rows for chrome (search box, footer, scroll hints) like the
  // reference, then halve for the two-line rows (name + dim description).
  const rows = process.stdout.rows || 24;
  const paneCap = contentHeight ?? Math.min(Math.floor(rows * 0.8), 30);
  const maxVisible = Math.max(5, paneCap - 6);
  const visibleRows = Math.max(4, Math.floor(maxVisible / 2));

  // Colors from the live theme object (kept in sync by syncLiveTheme on
  // theme changes), resolved for stock ink.
  const claude = resolveColor(theme.claude);
  const suggestion = resolveColor(theme.suggestion);

  // Persist a partial settings update, then re-read so the list reflects the
  // merge (saveSettings merges with existing settings on disk).
  const persist = (partial: PersistedSettings): void => {
    saveSettings(partial);
    setSettingsData(loadSettings());
  };

  // ── The settings list (only keys that exist in PersistedSettings) ────────
  const settingsItems = useMemo<Setting[]>(() => {
    const s = settingsData;
    return [
      {
        id: "model",
        label: "Model",
        description:
          "Model used for new sessions — deepseek-chat, deepseek-reasoner, or a custom model (model)",
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
          "Reasoning effort for deepseek-reasoner (effort): off sends nothing — the provider default applies",
        type: "enum" as const,
        value: s.effort ?? "off",
        options: EFFORT_OPTIONS,
        onChange: (v: string) => persist({ effort: v as EffortLevel }),
      },
      {
        id: "themeMode",
        label: "Theme",
        description:
          "Color theme — auto follows the terminal (themeMode). Theme changes apply immediately",
        type: "enum" as const,
        value: s.themeMode ?? "auto",
        options: THEME_OPTIONS,
        display: (v: string) => THEME_LABELS[v] ?? v,
        onChange: (v: string) => {
          const setting = v as ThemeSetting;
          persist({ themeMode: setting });
          // Repaint the live mutable `theme` object so every component that
          // reads tokens directly picks up the new palette.
          syncLiveTheme(resolveThemeSetting(setting));
        },
      },
      {
        id: "statusLine",
        label: "Status line",
        description:
          "Custom status bar command, set via /statusline (statusLine) — trust-gated, 5s timeout",
        type: "display" as const,
        value: s.statusLine ? `command: ${s.statusLine.command}` : "not set",
      },
      {
        id: "permissions",
        label: "Permissions",
        description:
          "Tool permission rules in allow/deny/ask form, set via /permissions or settings.json (permissions)",
        type: "display" as const,
        value: permissionSummary(s.permissions),
      },
      {
        id: "apiKey",
        label: "API key",
        description:
          "DeepSeek API key (apiKey) — masked: first 8 + last 4 shown. Editing replaces the key",
        type: "text" as const,
        value: maskApiKey(s.apiKey),
        // Never seed the edit with the masked value — start blank so typing
        // a new key replaces the old one (empty commit clears it).
        editSeed: "",
        onChange: (v: string) => {
          const trimmed = v.trim();
          persist({ apiKey: trimmed ? trimmed : undefined });
        },
      },
      {
        id: "provider",
        label: "Provider",
        description: "API provider profile used for requests (provider)",
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
        description: "API endpoint override, e.g. a proxy (baseURL)",
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
        description: "Default agent for new sessions (defaultAgent)",
        type: "enum" as const,
        value: s.defaultAgent ?? "code",
        options: AGENT_OPTIONS,
        onChange: (v: string) => persist({ defaultAgent: v }),
      },
      {
        id: "thinkingMode",
        label: "Thinking mode",
        description: "Thinking mode preference — whale or off (thinkingMode)",
        type: "enum" as const,
        value: s.thinkingMode ?? "off",
        options: THINKING_OPTIONS,
        onChange: (v: string) => persist({ thinkingMode: v }),
      },
      {
        id: "outputStyle",
        label: "Output style",
        description: "Output style for assistant messages (outputStyle)",
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
        description: "Add a Co-Authored-By trailer to /commit messages (includeCoAuthoredBy)",
        type: "boolean" as const,
        value: s.includeCoAuthoredBy ?? false,
        onChange: (v: boolean) => persist({ includeCoAuthoredBy: v }),
      },
      {
        id: "cleanupPeriodDays",
        label: "Cleanup period",
        description: "Delete saved sessions older than N days on startup (cleanupPeriodDays)",
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
        description: "Show the spinner tip / elapsed line (spinnerTipsEnabled)",
        type: "boolean" as const,
        value: s.spinnerTipsEnabled ?? true,
        onChange: (v: boolean) => persist({ spinnerTipsEnabled: v }),
      },
      {
        id: "verbose",
        label: "Verbose output",
        description: "Verbose debug logging (verbose)",
        type: "boolean" as const,
        value: s.verbose ?? false,
        onChange: (v: boolean) => persist({ verbose: v }),
      },
      {
        id: "env",
        label: "Env vars",
        description: "Environment variables injected into the session / tool environment (env)",
        type: "display" as const,
        value: `${Object.keys(s.env ?? {}).length} variable(s) configured`,
      },
    ];
  }, [settingsData]);

  // Filter settings by the search query (name or description, the reference
  // matches id/label — description is added per our data model).
  const filteredSettingsItems = useMemo(() => {
    const lowerQuery = searchQuery.trim().toLowerCase();
    if (!lowerQuery) return settingsItems;
    return settingsItems.filter((setting) => {
      if (setting.id.toLowerCase().includes(lowerQuery)) return true;
      if (setting.label.toLowerCase().includes(lowerQuery)) return true;
      return setting.description.toLowerCase().includes(lowerQuery);
    });
  }, [settingsItems, searchQuery]);

  // Keep the selected index within the filtered list, and keep the selected
  // item inside the visible window (reference behavior).
  useEffect(() => {
    if (selectedIndex >= filteredSettingsItems.length) {
      const newIndex = Math.max(0, filteredSettingsItems.length - 1);
      setSelectedIndex(newIndex);
      setScrollOffset(Math.max(0, newIndex - visibleRows + 1));
      return;
    }
    setScrollOffset((prev) => {
      if (selectedIndex < prev) return selectedIndex;
      if (selectedIndex >= prev + visibleRows) return selectedIndex - visibleRows + 1;
      return prev;
    });
  }, [filteredSettingsItems.length, selectedIndex, visibleRows]);

  // Hide the tab bar only while an inline edit is open (the reference hides
  // it for submenus only). Search mode keeps the tabs visible so ↑ can focus
  // the header and ←/→ can switch tabs — hiding them here is what stranded
  // the user in the search box with no path to the other tabs.
  useEffect(() => {
    setTabsHidden(editSetting !== null);
    return () => {
      setTabsHidden(false);
    };
  }, [editSetting, setTabsHidden]);

  // Tell the parent when Config's own Esc handler is active (search mode with
  // content focus) so the Settings shell cedes confirm:no — search clears the
  // query first, then exits; the pane closes only from list mode or with the
  // tab header focused (reference: ownsEsc = isSearchMode && !headerFocused).
  const ownsEsc = isSearchMode && !headerFocused;
  useEffect(() => {
    onIsSearchModeChange?.(ownsEsc);
  }, [ownsEsc, onIsSearchModeChange]);

  // ── Interactions ──────────────────────────────────────────────────────────

  const moveSelection = (delta: -1 | 1): void => {
    const newIndex = Math.max(
      0,
      Math.min(filteredSettingsItems.length - 1, selectedIndex + delta),
    );
    setSelectedIndex(newIndex);
    setScrollOffset((prev) => {
      if (newIndex < prev) return newIndex;
      if (newIndex >= prev + visibleRows) return newIndex - visibleRows + 1;
      return prev;
    });
  };

  // Enter/Space/←/→/Tab on a row: toggle booleans, cycle enums, open the
  // inline edit for free-text settings. Display rows are read-only.
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
    // display: read-only
  };

  const commitEdit = (): void => {
    const setting = filteredSettingsItems.find((s) => s.id === editSetting);
    setEditSetting(null);
    if (!setting || setting.type !== "text") return;
    if (setting.validate && !setting.validate(editValue)) return;
    setting.onChange(editValue);
  };

  // Single handler covering search mode, list mode, and inline edit mode.
  // Ink re-registers the handler on every render (inputHandler is an effect
  // dep), so the closure always sees fresh state.
  useInput((input: string, key: Key) => {
    // Inline edit of a free-text setting.
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

    // Tab row focused: ←/→/Tab switch tabs (Tabs' own handler) — cede all
    // keys so it doesn't double-fire with this pane's list interactions
    // (reference: handleKeyDown returns early when headerFocused).
    if (headerFocused) return;

    // Search mode: type to filter. Esc clears the query, then exits search.
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
        setScrollOffset(0);
        return;
      }
      if (key.upArrow) {
        // ↑ hands focus to the tab row (reference onExitUp: focusHeader) so
        // ←/→ switch tabs from search mode; ↓ returns focus to the list.
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

    // List mode.
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      if (selectedIndex === 0) {
        // ↑ at the top re-enters search (reference boundary behavior).
        setIsSearchMode(true);
        setScrollOffset(0);
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
      setScrollOffset(0);
      return;
    }
    if (key.pageDown) {
      const last = filteredSettingsItems.length - 1;
      setSelectedIndex(last);
      setScrollOffset(Math.max(0, last - visibleRows + 1));
      return;
    }
    // Enter/Space/←/→/Tab change the selected setting (reference: left/right/
    // tab cycle options; Enter on text rows opens the inline edit).
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
    // Any other printable character (including '/') drops into search with
    // that character as the query (reference behavior).
    if (input.length > 0) {
      setIsSearchMode(true);
      setSearchQuery(input);
      setCursorOffset(input.length);
    }
  });

  // ── Render ────────────────────────────────────────────────────────────────

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
          : "↑↓ navigate · Enter change · / search · Esc close";

  return (
    <Box flexDirection="column" width="100%" paddingX={1} gap={1}>
      {/* Search / edit row */}
      <Box flexDirection="row">
        <Text color={claude} bold>
          {editSetting !== null ? "✎ " : "❯ "}
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

      {/* Settings list */}
      <Box flexDirection="column">
        {filteredSettingsItems.length === 0 ? (
          <Text dimColor italic>
            {`No settings match "${searchQuery}"`}
          </Text>
        ) : (
          <>
            {scrollOffset > 0 && (
              <Text dimColor>{`↑ ${scrollOffset} more above`}</Text>
            )}
            {filteredSettingsItems
              .slice(scrollOffset, scrollOffset + visibleRows)
              .map((setting, i) => {
                const actualIndex = scrollOffset + i;
                const isSelected =
                  actualIndex === selectedIndex &&
                  !isSearchMode &&
                  editSetting === null;
                return (
                  <Box key={setting.id} flexDirection="column">
                    <Box flexDirection="row">
                      <Box width={38}>
                        <Text
                          color={isSelected ? suggestion : undefined}
                          bold={isSelected}
                        >
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
                    <Text dimColor>
                      {"  "}
                      {setting.description}
                    </Text>
                  </Box>
                );
              })}
            {scrollOffset + visibleRows < filteredSettingsItems.length && (
              <Text dimColor>{`↓ ${filteredSettingsItems.length - scrollOffset - visibleRows} more below`}</Text>
            )}
          </>
        )}
      </Box>

      <Text dimColor>{footer}</Text>
    </Box>
  );
}
