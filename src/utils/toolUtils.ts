// Shared utilities for tool implementations
//
// Extracted from the original tool/index.ts for reuse across per-directory tools.

import { resolve, relative, dirname } from "path";
import { mkdir } from "fs/promises";

// ─── Path resolution ─────────────────────────────────────────────────────────

export function resolvePath(workingDir: string, p: string | undefined | null): string {
  const cwd = resolve(workingDir);
  if (!p || typeof p !== "string") return cwd;
  return p.startsWith("/") ? p : resolve(cwd, p);
}

export function getCwd(workingDir: string): string {
  return resolve(workingDir);
}

export function relativePath(workingDir: string, fullPath: string): string {
  return relative(resolve(workingDir), fullPath);
}

/** Ensure parent directories exist */
export async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

// ─── Output formatting ───────────────────────────────────────────────────────

export function previewRawBlock(
  text: string,
  maxLines = 40,
  maxChars = 1200,
): string {
  const lines = text.split("\n");
  const clipped = lines.slice(0, maxLines);
  const withLineNotice =
    lines.length > maxLines
      ? `${clipped.join("\n")}\n... (${lines.length - maxLines} more lines)`
      : clipped.join("\n");

  if (withLineNotice.length <= maxChars) return withLineNotice;
  return withLineNotice.slice(0, maxChars) + "\n... (truncated)";
}

export function buildSimpleDiffPreview(
  oldText: string,
  newText: string,
  maxLines = 40,
): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  const out: string[] = [];

  for (let i = 0; i < max; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) continue;

    if (oldLine !== undefined) out.push(`-${oldLine}`);
    if (newLine !== undefined) out.push(`+${newLine}`);

    if (out.length >= maxLines) break;
  }

  if (out.length === 0) return "(no textual diff)";
  if (out.length >= maxLines) out.push("... (diff truncated)");
  return out.join("\n");
}

export function asAddedLines(text: string, maxLines = 40): string {
  const lines = text.split("\n");
  const clipped = lines.slice(0, maxLines).map((l) => `+${l}`);
  if (lines.length > maxLines)
    clipped.push(`... (${lines.length - maxLines} more lines)`);
  return clipped.join("\n");
}

// ─── File reading with line numbers ──────────────────────────────────────────

export function formatFileContent(
  content: string,
  offset = 0,
  limit?: number,
): string {
  const lines = content.split("\n");
  const start = Math.max(0, offset);
  const end = limit ? Math.min(lines.length, start + limit) : lines.length;
  return lines
    .slice(start, end)
    .map((line, i) => `${String(start + i + 1).padStart(4)}│${line}`)
    .join("\n");
}
