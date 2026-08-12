// FileReadTool — reads file contents with line numbers
//
// Text files are returned in cat -n format with line numbers. Beyond plain
// text, this tool handles:
//   - Jupyter notebooks (.ipynb): all code + markdown cells with outputs
//   - PDFs: best-effort embedded-text extraction (see pdf.ts for scope)
//   - Images (PNG/JPEG/GIF/WebP): a size + dimensions summary — the model
//     cannot view image content, so the bytes are NOT sent as a visual
//
// Safety:
//   - Binary files are detected (known-binary extension OR NUL-byte heuristic)
//     and returned as a short summary instead of decoding garbage into context.
//   - Device / pseudo-filesystem paths (/dev, /proc, /sys) are blocked, since
//     reading them can hang, leak kernel state, or produce unbounded streams.
//
// Limits (see src/utils/limits.ts):
//   - Whole-file reads of files larger than maxSizeBytes (256 KB default)
//     return an error before reading — use offset/limit for big files.
//   - Returned content over the token budget (25,000 tokens default) is
//     truncated at a line boundary with a marker naming the continuation
//     offset, so the model can pick up where it left off.

import { readFile, stat } from "fs/promises";
import { z } from "zod";
import { buildTool, type ToolResult } from "../../Tool.js";
import { resolvePath } from "../../utils/toolUtils.js";
import {
  hasBinaryContent,
  hasBinaryExtension,
  getExtension,
  isDeviceOrProcPath,
} from "../../constants/files.js";
import {
  estimateTokens,
  formatFileSize,
  getDefaultFileReadingLimits,
  truncateToTokenBudget,
} from "../../utils/limits.js";
import { FILE_READ_TOOL_NAME, DESCRIPTION, MAX_LINES_TO_READ } from "./prompt.js";
import {
  extractPDFText,
  PDF_MAX_PAGES_PER_READ,
  PDF_MAX_READ_SIZE_BYTES,
} from "./pdf.js";
import { readNotebookText } from "./notebook.js";
import { buildImageSummary, IMAGE_EXTENSIONS } from "./image.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Long lines are truncated at this many characters with an omission marker. */
const MAX_LINE_CHARS = 2000;

// ─── Input schema ────────────────────────────────────────────────────────────

const FileReadInputSchema = z.object({
  file_path: z.string().describe(
    "The absolute path to the file to read",
  ),
  offset: z.number().optional().describe(
    "The 1-based line number to start reading from. Only provide if the file is too large to read at once",
  ),
  limit: z.number().optional().describe(
    "The number of lines to read. Only provide if the file is too large to read at once",
  ),
});

// ─── Tool definition ─────────────────────────────────────────────────────────

export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: FileReadInputSchema,

  userFacingName: (input) => {
    const path = input.file_path ?? "";
    const lastPart = path.split("/").pop() ?? path;
    return `Read ${lastPart}`;
  },

  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  maxResultSizeChars: 100_000,

  checkPermissions: async (_input, context) => {
    if (!context.permissions.allowRead) {
      return { approved: false, feedback: "Read permission denied for this agent." };
    }
    return { approved: true };
  },

  call: async (input, context) => {
    const { file_path, offset, limit } = input;
    const fullPath = resolvePath(context.workingDir, file_path);

    // ── Block dangerous device / pseudo-filesystem paths ────────────────────
    if (isDeviceOrProcPath(fullPath)) {
      return {
        data:
          `Error: refusing to read device or pseudo-filesystem path "${fullPath}".\n` +
          `Paths under /dev, /proc, and /sys are blocked because reading them ` +
          `can hang, leak kernel state, or return unbounded data.`,
      };
    }

    try {
      // stat up front: gives us the size cap check for whole-file reads and a
      // clean ENOENT for missing files.
      const stats = await stat(fullPath);
      const ext = getExtension(fullPath);
      const limits = getDefaultFileReadingLimits();
      // Bun's Stats.size is typed number | bigint — normalize once.
      const sizeBytes = Number(stats.size);

      // ── Format-specific handling ──────────────────────────────────────────
      if (ext === "ipynb") return readNotebookResult(fullPath, sizeBytes, limits);
      if (ext === "pdf") return readPDFResult(fullPath, sizeBytes, limits);
      if (IMAGE_EXTENSIONS.has(ext)) return readImageResult(fullPath, sizeBytes);

      return readTextResult(fullPath, sizeBytes, { offset, limit }, limits);
    } catch (error) {
      return { data: `Error reading file: ${(error as Error).message}` };
    }
  },
});

// ─── Text files ──────────────────────────────────────────────────────────────

function renderLine(lineNo: number, line: string): string {
  if (line.length <= MAX_LINE_CHARS) {
    return `${String(lineNo).padStart(4)}│${line}`;
  }
  const omitted = line.length - MAX_LINE_CHARS;
  return (
    `${String(lineNo).padStart(4)}│${line.slice(0, MAX_LINE_CHARS)}` +
    ` ... [${omitted} chars omitted]`
  );
}

async function readTextResult(
  fullPath: string,
  sizeBytes: number,
  range: { offset?: number; limit?: number },
  limits: { maxTokens: number; maxSizeBytes: number },
): Promise<ToolResult<string>> {
  const { offset, limit } = range;

  // Whole-file reads are capped on TOTAL file size (cheap pre-read check).
  // Explicit range reads may target larger files.
  if (offset === undefined && limit === undefined && sizeBytes > limits.maxSizeBytes) {
    return {
      data:
        `Error: file is ${formatFileSize(sizeBytes)} (${sizeBytes} bytes), which exceeds ` +
        `the maximum read size of ${formatFileSize(limits.maxSizeBytes)}. ` +
        `Read specific portions with the offset and limit parameters, or use ` +
        `Grep to find the content you need.`,
    };
  }

  // Read raw bytes first so we can run binary detection before decoding.
  const buf = await readFile(fullPath);

  // A file is binary if it has a known-binary extension OR its contents
  // contain a NUL byte. The extension check also catches empty binary
  // files (e.g. a freshly-touched `foo.png` with 0 bytes), where the
  // null-byte scan is inconclusive.
  const isBinary =
    buf.length > 0 && (hasBinaryExtension(fullPath) || hasBinaryContent(buf));

  if (isBinary) {
    const ext = getExtension(fullPath);
    const typeLabel = ext ? `type ${ext}` : "unknown type";
    return {
      data: `Binary file (${buf.length} bytes, ${typeLabel}) — contents not shown.`,
    };
  }

  const content = buf.toString("utf-8");
  const lines = content.split("\n");
  // A file ending in "\n" splits into a phantom trailing empty line — drop
  // it so we don't render a bogus numbered line for nothing.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;

  // offset is 1-based per the schema ("line number to start reading from").
  const startIdx = offset !== undefined ? Math.max(0, offset - 1) : 0;

  if (offset !== undefined && startIdx >= totalLines) {
    return {
      data:
        `Warning: the file exists but is shorter than the provided offset (${offset}). ` +
        `The file has ${totalLines} lines.`,
    };
  }

  let endIdx: number;
  if (offset !== undefined || limit !== undefined) {
    // Explicit range: read exactly the requested window (bounded by EOF).
    const requestedEnd = limit !== undefined ? startIdx + limit : totalLines;
    endIdx = Math.min(totalLines, requestedEnd);
  } else {
    // Default: read from the beginning, up to MAX_LINES_TO_READ.
    endIdx = Math.min(totalLines, MAX_LINES_TO_READ);
  }

  const rendered = lines
    .slice(startIdx, endIdx)
    .map((line, i) => renderLine(startIdx + i + 1, line))
    .join("\n");

  let result = rendered || "(empty file)";

  // Token budget: truncate at a line boundary and point the model at the
  // continuation offset. Checked BEFORE the "more lines" note so the note
  // can't shift the line accounting.
  const trunc = truncateToTokenBudget(result, limits.maxTokens);
  if (trunc.truncated) {
    const nextLine = startIdx + trunc.keptLines + 1;
    result =
      trunc.content +
      `\n... [Truncated: content is ~${estimateTokens(result)} tokens, over the ` +
      `${limits.maxTokens}-token budget. File has ${totalLines} lines; ` +
      `continue with offset=${nextLine} to read the rest]`;
    return { data: result };
  }

  // Default full reads note how many lines were left unread.
  if (offset === undefined && limit === undefined && totalLines > endIdx) {
    result = `${result}\n... (${totalLines - endIdx} more lines)`;
  }
  return { data: result };
}

// ─── Jupyter notebooks ───────────────────────────────────────────────────────

async function readNotebookResult(
  fullPath: string,
  sizeBytes: number,
  limits: { maxTokens: number; maxSizeBytes: number },
): Promise<ToolResult<string>> {
  if (sizeBytes > limits.maxSizeBytes) {
    return {
      data:
        `Error: notebook file is ${formatFileSize(sizeBytes)} (${sizeBytes} bytes), which ` +
        `exceeds the maximum read size of ${formatFileSize(limits.maxSizeBytes)}. ` +
        `Use Bash with jq to read specific portions:\n` +
        `  cat "${fullPath}" | jq '.cells[:20]' # First 20 cells\n` +
        `  cat "${fullPath}" | jq '.cells | length' # Count total cells`,
    };
  }

  const { text, cellCount } = await readNotebookText(fullPath);
  let result = `Jupyter notebook: ${fullPath} (${cellCount} cell${cellCount === 1 ? "" : "s"})\n\n${text}`;

  const trunc = truncateToTokenBudget(result, limits.maxTokens);
  if (trunc.truncated) {
    result =
      trunc.content +
      `\n... [Truncated: notebook content is ~${estimateTokens(result)} tokens, over the ` +
      `${limits.maxTokens}-token budget. Use Bash with jq to inspect specific cells]`;
  }
  return { data: result };
}

// ─── PDFs ────────────────────────────────────────────────────────────────────

async function readPDFResult(
  fullPath: string,
  sizeBytes: number,
  limits: { maxTokens: number; maxSizeBytes: number },
): Promise<ToolResult<string>> {
  if (sizeBytes > PDF_MAX_READ_SIZE_BYTES) {
    return {
      data:
        `Error: PDF is ${formatFileSize(sizeBytes)} (${sizeBytes} bytes), which exceeds ` +
        `the maximum supported PDF size of ${formatFileSize(PDF_MAX_READ_SIZE_BYTES)}. ` +
        `Extract the text with an external tool (e.g. pdftotext) instead.`,
    };
  }

  const buf = await readFile(fullPath);
  const { text, pageCount } = extractPDFText(buf, limits.maxTokens * 4);

  const header = `PDF file: ${fullPath} (${pageCount} page${pageCount === 1 ? "" : "s"}, ${formatFileSize(sizeBytes)})`;
  const manyPagesNote =
    pageCount > PDF_MAX_PAGES_PER_READ
      ? `\nThis PDF has ${pageCount} pages; the text below is a partial extraction from the beginning.`
      : "";
  const caveat =
    "\nText is extracted best-effort: images, tables, charts, and layout are not " +
    "preserved; scanned (image-only) PDFs yield no text.";

  let result =
    header +
    manyPagesNote +
    caveat +
    "\n\n" +
    (text.length > 0
      ? text
      : "(no extractable text found — the PDF may consist of scanned images or use unsupported compression)");

  const trunc = truncateToTokenBudget(result, limits.maxTokens);
  if (trunc.truncated) {
    result =
      trunc.content +
      `\n... [Truncated: extracted PDF text is ~${estimateTokens(result)} tokens, over the ` +
      `${limits.maxTokens}-token budget. Use Bash with pdftotext for full extraction]`;
  }
  return { data: result };
}

// ─── Images ──────────────────────────────────────────────────────────────────

async function readImageResult(
  fullPath: string,
  sizeBytes: number,
): Promise<ToolResult<string>> {
  const buf = await readFile(fullPath);
  if (buf.length === 0) {
    return { data: `Error: image file is empty: ${fullPath}` };
  }
  return { data: buildImageSummary({ filePath: fullPath, sizeBytes, buf }) };
}
