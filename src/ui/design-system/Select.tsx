
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme, resolveColor, type Theme } from "../../utils/theme.js";

export interface SelectOption<T extends string = string> {
  label: string;
  value: T;
  /** Optional dim explanation rendered below the label. */
  description?: string;
  disabled?: boolean;
  /** Optional theme token: renders a colored ● before the label. */
  colorToken?: keyof Theme;
}

export interface SelectProps<T extends string = string> {
  options: ReadonlyArray<SelectOption<T>>;
  /** Fires when the user accepts the focused option (Enter or a number key). */
  onChange: (value: T) => void;
  /** Fires on Escape. */
  onCancel: () => void;
  /** Notifies on focus movement (for live-preview pickers). */
  onFocus?: (value: T) => void;
  /** Option focused when the list first appears. */
  defaultValue?: T;
  /** Window size for long lists (default 8). */
  visibleOptionCount?: number;
  /** Accept digits to jump-select an option and render dim index hints. */
  enableNumberKeys?: boolean;
  /** Bold the matching substring in every label (type-to-filter lists). */
  highlightText?: string;
  /** Set false when a sibling filter input owns the keyboard (its Esc
   *  returns focus to the list) — disables this Select's own key handling. */
  keysActive?: boolean;
}

function normalizeFullWidthDigits(input: string): string {
  return input.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
}

/** Bold the case-insensitive match of `highlight` inside `label`. */
function HighlightedLabel({ label, highlight }: { label: string; highlight?: string }): React.ReactElement {
  if (!highlight) return <>{label}</>;
  const idx = label.toLowerCase().indexOf(highlight.toLowerCase());
  if (idx < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, idx)}
      <Text bold color={resolveColor(theme.claude)}>{label.slice(idx, idx + highlight.length)}</Text>
      {label.slice(idx + highlight.length)}
    </>
  );
}

/**
 * Arrow-key list picker — the shared primitive behind the interactive slash
 * commands (model, agent, skills, rewind, …). Ported from Claude Code's
 * CustomSelect semantics: wrapping navigation, j/k and ctrl+n/p keys, page
 * keys, a `❯` focus marker, a `✓` marker on the confirmed option, digit-key
 * jumps by absolute index, dim descriptions, and edge scroll indicators.
 */
export function Select<T extends string = string>({
  options,
  onChange,
  onCancel,
  onFocus,
  defaultValue,
  visibleOptionCount = 8,
  enableNumberKeys = false,
  highlightText,
  keysActive = true,
}: SelectProps<T>): React.ReactElement {
  const focusColor = resolveColor(theme.claude);
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = options.findIndex((o) => o.value === defaultValue);
    return idx >= 0 ? idx : 0;
  });
  // The confirmed selection (✓ marker), updated on accept — reference
  // CustomSelect keeps isSelected in state so the tick follows the choice.
  const [confirmedValue, setConfirmedValue] = useState<T | undefined>(defaultValue);
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  const moveTo = useCallback(
    (index: number) => {
      if (options.length === 0) return;
      const next = ((index % options.length) + options.length) % options.length;
      setSelectedIndex(next);
      const option = options[next];
      if (option && !option.disabled) onFocus?.(option.value);
    },
    [options, onFocus],
  );

  // Keep the focused index valid when the option list changes underneath us.
  useEffect(() => {
    if (selectedIndex >= options.length) moveTo(Math.max(0, options.length - 1));
  }, [options.length, selectedIndex, moveTo]);

  useInput((input, key) => {
    if (!keysActive) return;
    if (key.upArrow || input === "k") {
      moveTo(selectedIndexRef.current - 1);
    } else if (key.downArrow || input === "j") {
      moveTo(selectedIndexRef.current + 1);
    } else if ((key.ctrl && input === "p") || (key.ctrl && input === "n")) {
      // ctrl+p / ctrl+n arrive as ctrl+pressed input
      moveTo(selectedIndexRef.current + (input === "p" ? -1 : 1));
    } else if (key.pageUp) {
      moveTo(selectedIndexRef.current - visibleOptionCount);
    } else if (key.pageDown) {
      moveTo(selectedIndexRef.current + visibleOptionCount);
    } else if (key.return) {
      const option = options[selectedIndexRef.current];
      if (option && !option.disabled) {
        setConfirmedValue(option.value);
        onChange(option.value);
      }
    } else if (key.escape) {
      onCancel();
    } else if (enableNumberKeys && !key.ctrl && /^[0-9]+$/.test(normalizeFullWidthDigits(input))) {
      // Absolute index into the full options array (reference semantics):
      // "3" selects the third option regardless of the visible window.
      const index = parseInt(normalizeFullWidthDigits(input), 10) - 1;
      const option = options[index];
      if (option && !option.disabled) {
        setSelectedIndex(index);
        setConfirmedValue(option.value);
        onChange(option.value);
      }
    }
  });

  if (options.length === 0) {
    return (
      <Text dimColor italic>(nothing to choose from — press Esc to dismiss)</Text>
    );
  }

  const { start, end, moreAbove, moreBelow } = visibleWindow(
    selectedIndex,
    options.length,
    visibleOptionCount,
  );
  const indexLabelWidth = enableNumberKeys ? String(options.length).length : 0;

  return (
    <Box flexDirection="column">
      {options.slice(start, end).map((option, visibleIdx) => {
        const i = start + visibleIdx;
        const focused = i === selectedIndex;
        const isSelected = option.value === confirmedValue;
        const marker = focused ? "❯ " : isSelected ? "✓ " : "  ";
        const shownIndex = i + 1; // absolute position in the full list

        let indicator: React.ReactNode;
        if (focused) {
          indicator = <Text color={focusColor}>{marker}</Text>;
        } else if (isSelected) {
          indicator = <Text color={resolveColor(theme.success)}>{marker}</Text>;
        } else if (moreAbove && i === start) {
          indicator = <Text dimColor>{"↑ "}</Text>;
        } else if (moreBelow && i === end - 1) {
          indicator = <Text dimColor>{"↓ "}</Text>;
        } else {
          indicator = <Text>{"  "}</Text>;
        }

        return (
          <Box key={option.value} flexDirection="column">
            <Box>
              {indicator}
              {enableNumberKeys && (
                <Text dimColor>{`${String(shownIndex).padStart(indexLabelWidth)}. `}</Text>
              )}
              <Text
                color={focused ? focusColor : option.disabled ? resolveColor(theme.inactive) : undefined}
                bold={focused}
                dimColor={option.disabled}
              >
                {option.colorToken && (
                  <Text color={resolveColor(theme[option.colorToken])}>● </Text>
                )}
                <HighlightedLabel label={option.label} highlight={highlightText} />
              </Text>
            </Box>
            {option.description && (
              <Box>
                <Text>{" ".repeat(2 + (enableNumberKeys ? indexLabelWidth + 2 : 0))}</Text>
                <Text dimColor wrap="truncate-end">
                  {option.description}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
      {options.length > end && (
        <Text dimColor>{`  and ${options.length - end} more…`}</Text>
      )}
    </Box>
  );
}

function visibleWindow(
  selectedIndex: number,
  count: number,
  visibleOptionCount: number,
): { start: number; end: number; moreAbove: boolean; moreBelow: boolean } {
  const size = Math.max(1, Math.min(visibleOptionCount, count));
  let start = Math.max(0, Math.min(selectedIndex - Math.floor(size / 2), count - size));
  const end = start + size;
  return { start, end, moreAbove: start > 0, moreBelow: end < count };
}

export default Select;
