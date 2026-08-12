// Symbol extraction at a position — ported from Claude Code's
// src/tools/LSPTool/symbolContext.ts.
//
// Extracts the symbol/word at a specific position in a file, used to show
// context in tool-use messages. The reference used a custom fsOperations
// abstraction; we use plain node:fs sync calls (Bun supports them), which
// keeps the same synchronous semantics with a simple try/catch fallback.

import { openSync, readSync, closeSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const MAX_READ_BYTES = 64 * 1024;

function debugLog(message: string): void {
  if (process.env.DEEPSEEK_CODE_DEBUG === "1" || process.env.DEBUG) {
    console.error(`[lsp] ${message}`);
  }
}

/**
 * Expands "~" to the home directory and resolves relative paths against cwd.
 * Mirrors the reference's expandPath() for the cases the tool uses.
 */
function expandPath(filePath: string, cwd?: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath.startsWith("/") ? filePath : resolve(cwd ?? process.cwd(), filePath);
}

/**
 * Truncates a string to a maximum length, appending an ellipsis if cut.
 */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

/**
 * Extracts the symbol/word at a specific position in a file.
 * Used to show context in tool use messages.
 *
 * @param filePath - The file path (absolute or relative)
 * @param line - 0-indexed line number
 * @param character - 0-indexed character position on the line
 * @param cwd - Working directory used to resolve relative paths (defaults to process.cwd())
 *
 * Note: This uses synchronous file I/O because it is called from synchronous
 * render paths. The read is wrapped in try/catch so ENOENT and other errors
 * fall back gracefully.
 * @returns The symbol at that position, or null if extraction fails
 */
export function getSymbolAtPosition(
  filePath: string,
  line: number,
  character: number,
  cwd?: string,
): string | null {
  try {
    const absolutePath = expandPath(filePath, cwd);

    // Read only the first 64KB instead of the whole file. Most LSP hover/goto
    // targets are near recent edits; 64KB covers ~1000 lines of typical code.
    // If the target line is past this window we fall back to null (callers
    // already handle that by showing `position: line:char`).
    const fd = openSync(absolutePath, "r");
    let bytesRead = 0;
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(MAX_READ_BYTES);
      bytesRead = readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
    } finally {
      closeSync(fd);
    }
    const content = buffer.toString("utf-8", 0, bytesRead);
    const lines = content.split("\n");

    if (line < 0 || line >= lines.length) {
      return null;
    }
    // If we filled the full buffer the file continues past our window,
    // so the last split element may be truncated mid-line.
    if (bytesRead === MAX_READ_BYTES && line === lines.length - 1) {
      return null;
    }

    const lineContent = lines[line];
    if (!lineContent || character < 0 || character >= lineContent.length) {
      return null;
    }

    // Extract the word/symbol at the character position
    // Pattern matches:
    // - Standard identifiers: alphanumeric + underscore + dollar
    // - Rust lifetimes: 'a, 'static
    // - Rust macros: macro_name!
    // - Operators and special symbols: +, -, *, etc.
    // This is more inclusive to handle various programming languages
    const symbolPattern = /[\w$'!]+|[+\-*/%&|^~<>=]+/g;
    let match: RegExpExecArray | null;

    while ((match = symbolPattern.exec(lineContent)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // Check if the character position falls within this match
      if (character >= start && character < end) {
        const symbol = match[0];
        // Limit length to 30 characters to avoid overly long symbols
        return truncate(symbol, 30);
      }
    }

    return null;
  } catch (error) {
    // Log unexpected errors for debugging (permission issues, encoding problems, etc.)
    if (error instanceof Error) {
      debugLog(
        `Symbol extraction failed for ${filePath}:${line}:${character}: ${error.message}`,
      );
    }
    // Still return null for graceful fallback to position display
    return null;
  }
}
