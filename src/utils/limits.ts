












export const DEFAULT_MAX_OUTPUT_TOKENS = 25_000;
export const DEFAULT_MAX_READ_SIZE_BYTES = 256 * 1024; 

export interface FileReadingLimits {
  
  maxTokens: number;
  
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


export function getDefaultFileReadingLimits(): FileReadingLimits {
  if (cachedLimits === undefined) {
    cachedLimits = {
      maxTokens: getEnvMaxTokens() ?? DEFAULT_MAX_OUTPUT_TOKENS,
      maxSizeBytes: getEnvMaxSizeBytes() ?? DEFAULT_MAX_READ_SIZE_BYTES,
    };
  }
  return cachedLimits;
}


export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TokenTruncation {
  
  content: string;
  
  truncated: boolean;
  
  keptLines: number;
}


export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
): TokenTruncation {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    // Count newlines without allocating a full lines array — this runs on
    // every FileRead result that fits the budget.
    let keptLines = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) keptLines++;
    }
    return { content: text, truncated: false, keptLines };
  }

  const lines = text.split("\n");
  let keptChars = 0;
  let keptLines = 0;
  for (const line of lines) {
    
    if (keptChars + line.length + 1 > maxChars) break;
    keptChars += line.length + 1;
    keptLines++;
  }

  if (keptLines === 0) {
    
    return { content: text.slice(0, maxChars), truncated: true, keptLines: 0 };
  }

  return {
    content: lines.slice(0, keptLines).join("\n"),
    truncated: true,
    keptLines,
  };
}


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
