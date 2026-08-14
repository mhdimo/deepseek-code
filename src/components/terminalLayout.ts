const DEFAULT_TERMINAL_ROWS = 40;

export const INK_RENDER_OPTIONS = {
  incrementalRendering: false,
} as const;

export function safeTerminalRows(rows: number | undefined, fallback = DEFAULT_TERMINAL_ROWS): number {
  if (!rows || rows < 1) return Math.max(1, fallback);
  return Math.max(1, Math.floor(rows));
}

export function separatorWidth(columns: number | undefined): number {
  return Math.max(1, Math.floor(columns || 1));
}

export function transcriptContainerHeight(rows: number, promptRows: number): number {
  return Math.max(0, rows - promptRows);
}
