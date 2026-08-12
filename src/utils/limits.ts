// File-reading limits for tools that pull file content into the model context
// (currently FileReadTool). Adapted from Claude Code's
// src/tools/FileReadTool/limits.ts, minus the experiment-flag plumbing.
//
//   | limit        | default | checks            | on overflow           |
//   |--------------|---------|-------------------|-----------------------|
//   | maxSizeBytes | 256 KB  | TOTAL FILE SIZE   | error pre-read        |
//   | maxTokens    | 25,000  | estimated output  | truncate w/ marker    |
//
// Token estimation uses the repo-wide heuristic (1 token ≈ 4 chars) that
// ContextManager already relies on, so truncation decisions stay consistent
// with auto-compaction behavior elsewhere in the codebase.

export const DEFAULT_MAX_OUTPUT_TOKENS = 25_000;
export const DEFAULT_MAX_READ_SIZE_BYTES = 256 * 1024; // 256 KiB

export interface FileReadingLimits {
  /** Estimated token budget for the content returned to the model. */
  maxTokens: number;
  /** Total file size cap for whole-file reads (explicit range reads are exempt). */
  maxSizeBytes: number;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  return undefined;
}

function getEnvMaxTokens(): number | undefined {
  return parsePositiveInt(process.env.DEEPSEEK_CODE_FILE_READ_MAX_OUTPUT_TOKENS);
}

function getEnvMaxSizeBytes(): number | undefined {
  return parsePositiveInt(process.env.DEEPSEEK_CODE_FILE_READ_MAX_SIZE_BYTES);
}

let cachedLimits: FileReadingLimits | undefined;

/**
 * Default limits for FileReadTool when nothing overrides them. Memoized so
 * env-var changes mid-session don't silently move the cap; precedence is
 * env var > hardcoded default.
 */
export function getDefaultFileReadingLimits(): FileReadingLimits {
  if (cachedLimits === undefined) {
    cachedLimits = {
      maxTokens: getEnvMaxTokens() ?? DEFAULT_MAX_OUTPUT_TOKENS,
      maxSizeBytes: getEnvMaxSizeBytes() ?? DEFAULT_MAX_READ_SIZE_BYTES,
    };
  }
  return cachedLimits;
}

/**
 * Rough token estimate matching ContextManager's heuristic (1 token ≈ 4 chars).
 * Deliberately cheap — this is used on every read, not an exact count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TokenTruncation {
  /** The kept prefix (may be empty). */
  content: string;
  /** Whether the content was cut. */
  truncated: boolean;
  /** Number of complete lines kept (only meaningful for line-oriented text). */
  keptLines: number;
}

/**
 * Truncate `text` (newline-separated lines) so its estimated token count fits
 * within `maxTokens`, cutting on a line boundary. The caller appends its own
 * marker — typically telling the model the total line count and which line
 * offset to continue from (keptLines maps 1:1 to lines of the input).
 *
 * If even the first line doesn't fit, the line itself is hard-cut.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
): TokenTruncation {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return { content: text, truncated: false, keptLines: text.length === 0 ? 0 : text.split("\n").length };
  }

  const lines = text.split("\n");
  let keptChars = 0;
  let keptLines = 0;
  for (const line of lines) {
    // +1 for the newline that joins lines in the output.
    if (keptChars + line.length + 1 > maxChars) break;
    keptChars += line.length + 1;
    keptLines++;
  }

  if (keptLines === 0) {
    // Even the first line doesn't fit — hard-cut mid-line.
    return { content: text.slice(0, maxChars), truncated: true, keptLines: 0 };
  }

  return {
    content: lines.slice(0, keptLines).join("\n"),
    truncated: true,
    keptLines,
  };
}

/** Human-readable file size, e.g. "1.2 MB" / "512 B". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  const rounded =
    value >= 100
      ? Math.round(value).toString()
      : value.toFixed(1);
  return `${rounded} ${unit}`;
}
