
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme, resolveColor, type Theme } from "../../utils/theme.js";
import { displayWidth } from "./Divider.js";

export interface SelectOption<T extends string = string> {
  label: string;
  value: T;
  /** Optional dim explanation. While any visible option carries one the
   *  reference lays every row out in one line — label column then a
   *  description column — instead of hanging it under the label. */
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
  /** Window size for long lists (default 5, the reference's default). */
  visibleOptionCount?: number;
  /** Render the dim `N.` index cell and let a digit jump to that option.
   *  On by default: the reference's Select hides neither unless the caller
   *  asks (`hideIndexes` defaults to false). */
  enableNumberKeys?: boolean;
  /** Bold the matching substring in every label (type-to-filter lists). */
  highlightText?: string;
  /** Set false when a sibling filter input owns the keyboard (its Esc
   *  returns focus to the list) — disables this Select's own key handling. */
  keysActive?: boolean;
  /** Replaces the list when there is nothing to choose from. */
  emptyMessage?: string;
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
      <Text bold>{label.slice(idx, idx + highlight.length)}</Text>
      {label.slice(idx + highlight.length)}
    </>
  );
}

/** The row's colour, named by theme token like the reference's `optionColor`. */
export type SelectRowColor = "success" | "suggestion" | "inactive";

/** Columns the marker gutter takes: the pointer or an arrow, plus its gap. */
export const MARKER_WIDTH = 2;

/** Columns the trailing confirmed tick takes: a space and the glyph. */
export const TICK_WIDTH = 2;

/** The focus pointer / scroll arrow / blank that opens every row. */
export interface SelectMarker {
  text: string;
  color?: SelectRowColor;
  dim?: boolean;
}

/** One option row, laid out the way the reference's compact Select is. */
export interface SelectRowModel {
  marker: SelectMarker;
  /** Dim `N. ` index cell — empty when the index column is hidden. */
  index: string;
  /** Label colour token; `undefined` leaves the row at the default colour. */
  color?: SelectRowColor;
  /** Trailing ` ✔` on the row holding the confirmed value. */
  tick: string;
  /** Spaces padding the label column out to the widest row (two-column rows). */
  padding: string;
  /** Description column text — `" "` on rows without one, so every
   *  description starts in the same column. Only set in the two-column
   *  layout; the stacked layout has no description column at all. */
  description?: string;
}

export interface SelectRowInput {
  /** 0-based position in the full option list (the index cell shows +1). */
  index: number;
  label: string;
  focused: boolean;
  selected: boolean;
  disabled?: boolean;
  description?: string;
  /** Columns a ● colour dot takes before the label, if the row has one. */
  prefixWidth?: number;
  /** Digits in the widest index cell; 0 hides the index column. */
  indexWidth: number;
  /** Widest label column, used to pad the two-column rows. */
  maxLabelWidth: number;
  /** True while any visible option carries a description (the reference's
   *  `hasDescriptions`): label and description share one row. */
  twoColumn: boolean;
  isFirstVisible: boolean;
  isLastVisible: boolean;
  moreAbove: boolean;
  moreBelow: boolean;
}

/** Width of one row's label column — the reference's `dataIndexWidth`: the
 *  marker gutter, the index cell, the ● dot and the label, plus the two
 *  columns the trailing tick takes on the confirmed row. */
export function selectLabelWidth({
  label,
  indexWidth,
  prefixWidth = 0,
  selected,
}: {
  label: string;
  indexWidth: number;
  prefixWidth?: number;
  selected: boolean;
}): number {
  return (
    MARKER_WIDTH +
    (indexWidth > 0 ? indexWidth + 2 : 0) +
    prefixWidth +
    displayWidth(label) +
    (selected ? TICK_WIDTH : 0)
  );
}

export function selectRowModel({
  index,
  label,
  focused,
  selected,
  disabled,
  description,
  prefixWidth,
  indexWidth,
  maxLabelWidth,
  twoColumn,
  isFirstVisible,
  isLastVisible,
  moreAbove,
  moreBelow,
}: SelectRowInput): SelectRowModel {
  // The reference's gutter order: the focus pointer, then the down arrow,
  // then the up arrow, otherwise a blank.
  const marker: SelectMarker = focused
    ? { text: "❯ ", color: "suggestion" }
    : moreBelow && isLastVisible
      ? { text: "↓ ", dim: true }
      : moreAbove && isFirstVisible
        ? { text: "↑ ", dim: true }
        : { text: "  " };

  // `isOptionDisabled ? undefined : isSelected ? "success" : isFocused ?
  // "suggestion" : undefined` — selected wins over focused, and the label is
  // never bolded. A disabled row is left uncoloured rather than painted
  // `inactive`: Select passes `styled={false}`, so ListItem's own
  // `disabled → inactive` default is not what the reference renders here.
  // Both branches dim it instead (see the render below); the description does
  // the same.
  const color: SelectRowColor | undefined = disabled
    ? undefined
    : selected
      ? "success"
      : focused
        ? "suggestion"
        : undefined;

  // The confirmed row ends with the tick, disabled or not. ListItem's own
  // contract gates it on `!disabled`, but its `disabled` prop defaults to
  // false and `SelectOptionProps` has no field to set it — so through Select
  // that gate is never armed, and the flat branch shows the tick exactly as
  // the two-column branch does.
  const tick = selected ? " ✔" : "";

  const columns = selectLabelWidth({ label, indexWidth, prefixWidth, selected });
  const padding =
    twoColumn && maxLabelWidth > columns ? " ".repeat(maxLabelWidth - columns) : "";

  return {
    marker,
    index: indexWidth > 0 ? `${index + 1}.`.padEnd(indexWidth + 2) : "",
    color,
    tick,
    padding,
    description: twoColumn ? description || " " : undefined,
  };
}

/**
 * Arrow-key list picker — the shared primitive behind the interactive slash
 * commands (model, agent, skills, rewind, …). Ported from Claude Code's
 * CustomSelect semantics: wrapping navigation, j/k and ctrl+n/p keys, page
 * keys, a dim padded index column, digit-key jumps, a `❯` focus pointer, a
 * trailing `✔` on the confirmed option, dim descriptions sharing the row with
 * the label, and edge scroll indicators.
 */
export function Select<T extends string = string>({
  options,
  onChange,
  onCancel,
  onFocus,
  defaultValue,
  visibleOptionCount = 5,
  enableNumberKeys = true,
  highlightText,
  keysActive = true,
  emptyMessage,
}: SelectProps<T>): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = options.findIndex((o) => o.value === defaultValue);
    return idx >= 0 ? idx : 0;
  });
  // The confirmed selection (✔ marker), updated on accept — reference
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
    return <Text>{emptyMessage ?? "Nothing to choose from."}</Text>;
  }

  const { start, end, moreAbove, moreBelow } = visibleWindow(
    selectedIndex,
    options.length,
    visibleOptionCount,
  );
  const windowOptions = options.slice(start, end);
  const indexWidth = enableNumberKeys ? String(options.length).length : 0;
  const dotWidth = (option: SelectOption<T>): number => (option.colorToken ? displayWidth("● ") : 0);
  // The reference switches to a one-row, two-column layout as soon as any
  // visible option carries a description, padding the label column out to
  // the widest row so the descriptions line up.
  const twoColumn = windowOptions.some((option) => option.description);
  const maxLabelWidth = twoColumn
    ? Math.max(
        ...windowOptions.map((option) =>
          selectLabelWidth({
            label: option.label,
            indexWidth,
            prefixWidth: dotWidth(option),
            selected: option.value === confirmedValue,
          }),
        ),
      )
    : 0;
  // Reference: total options minus the visible window — the rows the window
  // is hiding, not the ones below the cursor.
  const hiddenCount = Math.max(0, options.length - (end - start));

  return (
    <Box flexDirection="column">
      {windowOptions.map((option, visibleIdx) => {
        const i = start + visibleIdx;
        const focused = i === selectedIndex;
        const isSelected = option.value === confirmedValue;
        const row = selectRowModel({
          index: i,
          label: option.label,
          focused,
          selected: isSelected,
          disabled: option.disabled === true,
          description: option.description,
          prefixWidth: dotWidth(option),
          indexWidth,
          maxLabelWidth,
          twoColumn,
          isFirstVisible: i === start,
          isLastVisible: i === end - 1,
          moreAbove,
          moreBelow,
        });
        const labelColor = row.color ? resolveColor(theme[row.color]) : undefined;
        const labelContent = (
          <>
            {option.colorToken && (
              <Text color={resolveColor(theme[option.colorToken])}>● </Text>
            )}
            <HighlightedLabel label={option.label} highlight={highlightText} />
          </>
        );
        const indexCell = row.index ? <Text dimColor>{row.index}</Text> : null;
        const marker = (
          <Text
            color={row.marker.color ? resolveColor(theme[row.marker.color]) : undefined}
            dimColor={row.marker.dim}
          >
            {row.marker.text}
          </Text>
        );
        const tick = row.tick ? (
          <Text color={resolveColor(theme.success)}>{row.tick}</Text>
        ) : null;

        if (twoColumn) {
          return (
            <Box key={option.value} flexDirection="row">
              <Box flexDirection="row" flexShrink={0}>
                {marker}
                <Text color={labelColor} dimColor={option.disabled}>
                  {indexCell}
                  {labelContent}
                </Text>
                {tick}
                {row.padding ? <Text>{row.padding}</Text> : null}
              </Box>
              <Box flexGrow={1} marginLeft={2}>
                <Text wrap="wrap" dimColor color={labelColor}>
                  {row.description}
                </Text>
              </Box>
            </Box>
          );
        }

        return (
          <Box key={option.value} flexDirection="row">
            {marker}
            {indexCell}
            <Text color={labelColor} dimColor={option.disabled}>
              {labelContent}
            </Text>
            {tick}
          </Box>
        );
      })}
      {hiddenCount > 0 && (
        <Box paddingLeft={3}>
          <Text dimColor>{`and ${hiddenCount} more…`}</Text>
        </Box>
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
