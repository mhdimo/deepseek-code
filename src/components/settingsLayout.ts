import type { Setting } from "./settingsRows.js";

/**
 * The Config tab's window arithmetic and value formatting, kept out of the
 * component: these decide what the panel actually shows, and the TUI cannot be
 * driven from a test to find out.
 *
 * The numbers mirror upstream's Config. Ten rows of chrome — the search box,
 * the gaps around it, the hint line and the two scroll markers — come off the
 * height the Settings shell pins every tab to, so the list scrolls inside the
 * pane instead of growing it and jolting the tab row when you switch tabs.
 */

export const SETTINGS_LABEL_WIDTH = 44;
export const SETTINGS_POINTER = "❯";

const CHROME_ROWS = 10;
const MIN_VISIBLE_ROWS = 5;
const PANE_CAP_FALLBACK = 30;

export function settingsMaxVisible(
  contentHeight: number | undefined,
  terminalRows: number,
): number {
  const paneCap =
    contentHeight ?? Math.min(Math.floor(terminalRows * 0.8), PANE_CAP_FALLBACK);
  return Math.max(MIN_VISIBLE_ROWS, paneCap - CHROME_ROWS);
}

export interface SettingsWindow {
  /** First visible index. */
  start: number;
  /** Exclusive end. */
  end: number;
  /** Rows hidden above/below, for the "N more above" markers. */
  above: number;
  below: number;
}

/**
 * The visible slice, given the row the cursor is on and where the window sat
 * last time. The offset is sticky rather than recentred on every move: a list
 * that jumps each time you step through it is unreadable, so the window only
 * moves when the cursor would otherwise leave it.
 */
export function settingsWindow(
  total: number,
  selectedIndex: number,
  maxVisible: number,
  offset: number,
): SettingsWindow {
  const maxStart = Math.max(0, total - maxVisible);
  let start = Math.min(Math.max(0, offset), maxStart);
  if (selectedIndex < start) start = selectedIndex;
  else if (selectedIndex >= start + maxVisible) start = selectedIndex - maxVisible + 1;
  start = Math.min(Math.max(0, start), maxStart);
  const end = Math.min(total, start + maxVisible);
  return { start, end, above: start, below: Math.max(0, total - end) };
}

export function formatSettingValue(setting: Setting): string {
  if (setting.type === "enum") return setting.display?.(setting.value) ?? setting.value;
  if (setting.type === "boolean") return setting.value ? "true" : "false";
  return setting.value;
}

export type SettingsLine =
  | {
      kind: "row";
      id: string;
      label: string;
      value: string;
      selected: boolean;
    }
  | { kind: "more"; direction: "above" | "below"; count: number }
  | { kind: "empty" };

export function buildSettingsLines(
  rows: readonly Setting[],
  opts: {
    selectedIndex: number;
    maxVisible: number;
    offset: number;
    /** False while searching or editing, when the cursor is not on a row. */
    showSelection: boolean;
  },
): SettingsLine[] {
  if (rows.length === 0) return [{ kind: "empty" }];

  const { start, end, above, below } = settingsWindow(
    rows.length,
    opts.selectedIndex,
    opts.maxVisible,
    opts.offset,
  );

  const lines: SettingsLine[] = [];
  if (above > 0) lines.push({ kind: "more", direction: "above", count: above });
  for (let i = start; i < end; i++) {
    const row = rows[i]!;
    lines.push({
      kind: "row",
      id: row.id,
      label: row.label,
      value: formatSettingValue(row),
      selected: opts.showSelection && i === opts.selectedIndex,
    });
  }
  if (below > 0) lines.push({ kind: "more", direction: "below", count: below });
  return lines;
}

/** Search over what the row is called and what it does — the id is included so
 *  a settings.json key can be typed verbatim and still find its row. */
export function settingMatches(setting: Setting, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    setting.id.toLowerCase().includes(q) ||
    setting.label.toLowerCase().includes(q) ||
    setting.description.toLowerCase().includes(q)
  );
}
