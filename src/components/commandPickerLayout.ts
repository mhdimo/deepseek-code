const DEFAULT_MAX_VISIBLE = 6;

export function commandColumnWidth(columns: number): number {
  return Math.max(16, Math.min(40, Math.floor(columns * 0.4)));
}

export function truncateCommandDescription(description: string, width: number): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (width <= 0) return "";
  if (normalized.length <= width) return normalized;
  if (width === 1) return "…";
  return `${normalized.slice(0, width - 1)}…`;
}

export function visibleCommandRange(
  total: number,
  selected: number,
  maxVisible = DEFAULT_MAX_VISIBLE,
): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };

  const visibleCount = Math.max(1, Math.min(total, maxVisible));
  const selectedIndex = Math.max(0, Math.min(total - 1, selected));
  const centeredStart = selectedIndex - Math.floor(visibleCount / 2);
  const start = Math.max(0, Math.min(centeredStart, total - visibleCount));
  return { start, end: start + visibleCount };
}
