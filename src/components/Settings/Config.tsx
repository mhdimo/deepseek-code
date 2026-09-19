import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout, type Key } from "ink";
import {
  loadSettings,
  saveSettings,
  type PersistedSettings,
} from "../../state/storage.js";
import { useTabHeaderFocus } from "../../ui/design-system/Tabs.js";
import { Select, type SelectOption } from "../../ui/design-system/Select.js";
import { listOutputStyles } from "../../services/outputStyles.js";
import type { ThinkingMode } from "../../types/index.js";
import {
  resolveColor,
  theme,
  type ThemeSetting,
} from "../../utils/theme.js";
import ThemePicker from "../ThemePicker.js";
import { stripMouseSequences } from "../useMouseWheelScroll.js";
import {
  buildSettingsRows,
  MODEL_OPTIONS,
  type Setting,
  type SettingsRowHandlers,
} from "../settingsRows.js";
import {
  buildSettingsLines,
  settingMatches,
  settingsMaxVisible,
  settingsWindow,
  SETTINGS_LABEL_WIDTH,
  SETTINGS_POINTER,
} from "../settingsLayout.js";

const SEARCH_PLACEHOLDER = "Search settings…";

/**
 * The rows the reference opens a picker for rather than editing in place: it
 * renders the ThemePicker / a model list / a style list over the whole panel
 * (and hides the tab row) as soon as one of these is accepted. Cycling the
 * value in the row instead left the user on a different screen from the one
 * the same key press opens upstream.
 */
const PICKER_ROWS: Record<string, true> = {
  themeMode: true,
  model: true,
  outputStyle: true,
};

export interface ConfigProps {
  /** Unused by the panel, kept for the command context callers pass in. */
  context?: unknown;
  onClose: () => void;
  setTabsHidden: (hidden: boolean) => void;
  onIsSearchModeChange?: (inSearchMode: boolean) => void;
  /** The Settings shell pins every tab to this height so switching tabs does
   *  not resize the pane; the list scrolls inside it. */
  contentHeight?: number;
  /** Live-apply hooks for the rows whose value is also read while running. */
  onSkipPermissionsChange?: (value: boolean) => void;
  onThinkingModeChange?: (mode: ThinkingMode) => void;
  onThemeModeChange?: (setting: ThemeSetting) => void;
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

/** The model row's picker: the built-in ids, plus whatever custom id the
 *  settings file names so the current value stays selectable. */
function modelPickerOptions(current: string): SelectOption[] {
  const options: SelectOption[] = MODEL_OPTIONS.map((m) => ({ ...m }));
  if (!options.some((o) => o.value === current)) {
    options.push({ label: current, value: current, description: "Currently configured" });
  }
  return options;
}

/** The picker rows are the value-carrying ones, never the read-only displays. */
function findPickerSetting(
  settings: readonly Setting[],
  id: string | null,
): (Setting & { type: "enum" | "text" }) | undefined {
  if (id === null) return undefined;
  const found = settings.find((s) => s.id === id);
  return found && (found.type === "enum" || found.type === "text") ? found : undefined;
}

export default function Config({
  onClose,
  setTabsHidden,
  onIsSearchModeChange,
  contentHeight,
  onSkipPermissionsChange,
  onThinkingModeChange,
  onThemeModeChange,
}: ConfigProps): React.ReactElement {
  const { headerFocused, focusHeader } = useTabHeaderFocus();
  const { stdout } = useStdout();
  const [settingsData, setSettingsData] = useState<PersistedSettings>(() => loadSettings());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [isSearchMode, setIsSearchMode] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [editSetting, setEditSetting] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  /** Which managed row's picker is covering the panel, if any. */
  const [pickerRow, setPickerRow] = useState<string | null>(null);

  const suggestion = resolveColor(theme.suggestion);
  const maxVisible = settingsMaxVisible(contentHeight, stdout.rows ?? 24);
  // The reference feeds SearchBox `isFocused={isSearchMode && !headerFocused}`:
  // with the tab row focused the box is not focused either.
  const searchFocused = isSearchMode && !headerFocused;

  const persist = (partial: PersistedSettings): void => {
    saveSettings(partial);
    setSettingsData(loadSettings());
  };

  const handlers: SettingsRowHandlers = {
    onSkipPermissionsChange,
    onThinkingModeChange,
    onThemeModeChange,
  };
  const settingsItems: Setting[] = buildSettingsRows({
    settings: settingsData,
    persist,
    handlers,
  });

  const filteredSettingsItems = settingsItems.filter((setting) =>
    settingMatches(setting, searchQuery),
  );

  // The cursor is kept inside the window here rather than at render time: a
  // frame where the selection sits outside the slice would show the markers
  // moving without the highlight, and the offset has to survive the moves that
  // stay inside the window for the list to stop jumping under the user.
  const selectIndex = (index: number): void => {
    const clamped = Math.max(0, Math.min(filteredSettingsItems.length - 1, index));
    setSelectedIndex(clamped);
    setScrollOffset((offset) =>
      settingsWindow(filteredSettingsItems.length, clamped, maxVisible, offset).start,
    );
  };

  useEffect(() => {
    if (selectedIndex < filteredSettingsItems.length) return;
    const clamped = Math.max(0, filteredSettingsItems.length - 1);
    setSelectedIndex(clamped);
    setScrollOffset((offset) =>
      settingsWindow(filteredSettingsItems.length, clamped, maxVisible, offset).start,
    );
  }, [filteredSettingsItems.length, selectedIndex, maxVisible]);

  // Both the inline editor and a managed row's picker cover the panel, and the
  // reference hides the tab row for both (setTabsHidden(true) alongside
  // setShowSubmenu) so the picker's own Esc is the only one listening.
  useEffect(() => {
    setTabsHidden(editSetting !== null || pickerRow !== null);
    return () => {
      setTabsHidden(false);
    };
  }, [editSetting, pickerRow, setTabsHidden]);

  const ownsEsc = isSearchMode && !headerFocused;
  useEffect(() => {
    onIsSearchModeChange?.(ownsEsc);
  }, [ownsEsc, onIsSearchModeChange]);

  const toggleSetting = (): void => {
    const setting = filteredSettingsItems[selectedIndex];
    if (!setting) return;
    // The managed rows open their picker; neither the enum cycle below nor the
    // inline text editor is what the same key does upstream.
    if (PICKER_ROWS[setting.id]) {
      setPickerRow(setting.id);
      return;
    }
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
    // The picker owns the keyboard while it is up.
    if (pickerRow !== null) return;

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
      // A click while a value is being edited arrives as a mouse report, not
      // text — strip it so the sequence never lands in the setting.
      const typed = stripMouseSequences(input);
      if (typed.length > 0) {
        setEditValue((v) => v + typed);
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
        selectIndex(0);
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
      // Mouse reports arrive with an empty key name; strip them so a click
      // while the settings search has focus does not become part of the query.
      const typed = stripMouseSequences(input);
      if (typed.length > 0) {
        setSearchQuery((q) => q.slice(0, cursorOffset) + typed + q.slice(cursorOffset));
        setCursorOffset((c) => c + typed.length);
      }
      return;
    }

    // List mode. Enter saves and closes (Settings' `settings:close`); the rows
    // themselves are changed with Space, and left/right/tab cycle the focused
    // option — the same split the reference documents on its hint line.
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      onClose();
      return;
    }
    if (key.upArrow) {
      if (selectedIndex === 0) {
        setIsSearchMode(true);
        return;
      }
      selectIndex(selectedIndex - 1);
      return;
    }
    if (key.downArrow) {
      selectIndex(selectedIndex + 1);
      return;
    }
    if (key.pageUp) {
      selectIndex(0);
      return;
    }
    if (key.pageDown) {
      selectIndex(filteredSettingsItems.length - 1);
      return;
    }
    if (key.tab || key.leftArrow || key.rightArrow || (!key.ctrl && !key.meta && input === " ")) {
      toggleSetting();
      return;
    }
    // "/" opens search (settings:search) rather than filtering by a literal
    // slash — every other printable character still seeds the query.
    if (!key.ctrl && !key.meta && input === "/") {
      setIsSearchMode(true);
      setSearchQuery("");
      setCursorOffset(0);
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

  const pickerSetting = findPickerSetting(settingsItems, pickerRow);

  const outputStyleOptions = useMemo(
    (): SelectOption[] =>
      pickerRow === "outputStyle"
        ? listOutputStyles().map((style) => ({
            label: style.name,
            value: style.name,
            description: style.description,
          }))
        : [],
    [pickerRow],
  );

  const lines = buildSettingsLines(filteredSettingsItems, {
    selectedIndex,
    maxVisible,
    offset: scrollOffset,
    showSelection: !isSearchMode && editSetting === null && !headerFocused,
  });

  const footer =
    editSetting !== null
      ? "Enter save · Esc cancel"
      : headerFocused
        ? "←/→ tab to switch · ↓ to return · Esc to close"
        : isSearchMode
          ? "Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear"
          : "Space to change · Enter to save · / to search · Esc to cancel";

  const closePicker = (): void => setPickerRow(null);

  const picker =
    pickerRow === "themeMode" ? (
      <>
        <ThemePicker
          initialTheme={(pickerSetting?.value ?? "auto") as ThemeSetting}
          onThemeSelect={(setting) => {
            setPickerRow(null);
            pickerSetting?.onChange(setting);
          }}
          onCancel={closePicker}
        />
        <Box>
          <Text dimColor italic>Enter to select · Esc to cancel</Text>
        </Box>
      </>
    ) : pickerRow === "model" ? (
      <>
        <Select
          options={modelPickerOptions(pickerSetting?.value ?? "")}
          defaultValue={pickerSetting?.value}
          onChange={(value) => {
            setPickerRow(null);
            pickerSetting?.onChange(value);
          }}
          onCancel={closePicker}
          enableNumberKeys
        />
        <Box>
          <Text dimColor italic>Enter to confirm · Esc to cancel</Text>
        </Box>
      </>
    ) : pickerRow === "outputStyle" ? (
      <>
        <Select
          options={outputStyleOptions}
          defaultValue={pickerSetting?.value}
          // Same list /output-style shows, and the reference gives that picker
          // a ten-row window; custom styles can push it past the shared default.
          visibleOptionCount={10}
          onChange={(value) => {
            setPickerRow(null);
            pickerSetting?.onChange(value);
          }}
          onCancel={closePicker}
          enableNumberKeys
        />
        <Box>
          <Text dimColor italic>Enter to confirm · Esc to cancel</Text>
        </Box>
      </>
    ) : null;

  return (
    <Box flexDirection="column" width="100%">
      {picker !== null ? (
        picker
      ) : (
        // The panel itself carries no horizontal padding — the Settings pane
        // already insets its content by two columns, and the two blank rows
        // (marginY) are what the reference puts around its search box.
        <Box flexDirection="column" gap={1} marginY={1}>
          {/* Search box — the same row doubles as the inline editor, so the panel
              never loses the line the user is looking at. */}
          <Box
            flexDirection="row"
            borderStyle="round"
            borderColor={searchFocused ? suggestion : undefined}
            borderDimColor={!searchFocused}
            paddingX={1}
          >
            <Text dimColor={!searchFocused}>
              {editSetting !== null ? "✎ " : "⌕ "}
            </Text>
            {editSetting !== null && editingSetting?.type === "text" ? (
              <>
                <Text dimColor>
                  {`Edit ${editingSetting.label}: `}
                </Text>
                {renderCursorText(editValue, editValue.length, true)}
              </>
            ) : searchFocused ? (
              searchQuery.length > 0 ? (
                renderCursorText(searchQuery, cursorOffset, true)
              ) : (
                <Text>
                  <Text inverse>{SEARCH_PLACEHOLDER.charAt(0)}</Text>
                  <Text dimColor>{SEARCH_PLACEHOLDER.slice(1)}</Text>
                </Text>
              )
            ) : (
              <Text>
                {searchQuery.length > 0 ? searchQuery : SEARCH_PLACEHOLDER}
              </Text>
            )}
          </Box>

          <Box flexDirection="column">
            {lines.map((line) =>
              line.kind === "empty" ? (
                <Text key="empty" dimColor italic>
                  {`No settings match "${searchQuery}"`}
                </Text>
              ) : line.kind === "more" ? (
                <Text key={`more-${line.direction}`} dimColor>
                  {line.direction === "above"
                    ? `↑ ${line.count} more above`
                    : `↓ ${line.count} more below`}
                </Text>
              ) : (
                <Box key={line.id} flexDirection="row">
                  <Box width={SETTINGS_LABEL_WIDTH}>
                    <Text color={line.selected ? suggestion : undefined}>
                      {line.selected ? `${SETTINGS_POINTER} ` : "  "}
                      {line.label}
                    </Text>
                  </Box>
                  <Text color={line.selected ? suggestion : undefined}>{line.value}</Text>
                </Box>
              ),
            )}
          </Box>

          <Text dimColor>{footer}</Text>
        </Box>
      )}
    </Box>
  );
}
