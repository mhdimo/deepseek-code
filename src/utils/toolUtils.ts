// Shared utilities for tool implementations
//
// Extracted from the original tool/index.ts for reuse across per-directory tools.

import { resolve, relative, dirname } from "path";
import { mkdir } from "fs/promises";
import { diffLines } from "diff";

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
  const patch = diffLines(oldText, newText, { ignoreWhitespace: false });
  const out: string[] = [];

  for (const part of patch) {
    if (part.added) {
      for (const l of part.value.replace(/\n$/, "").split("\n")) {
        out.push(`+${l}`);
        if (out.length >= maxLines) break;
      }
    } else if (part.removed) {
      for (const l of part.value.replace(/\n$/, "").split("\n")) {
        out.push(`-${l}`);
        if (out.length >= maxLines) break;
      }
    } else {
      const lines = part.value.replace(/\n$/, "").split("\n");
      // Show up to 2 context lines on each side of a change
      for (let i = 0; i < lines.length; i++) {
        if (i < 2 || i >= lines.length - 2) {
          out.push(` ${lines[i]}`);
        } else {
          if (out[out.length - 1] !== " ...") {
            out.push(" ...");
          }
        }
        if (out.length >= maxLines) break;
      }
    }
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

// ─── System Prompt Environment Injection ─────────────────────────────────────

export function buildSystemInstructions(systemPrompt: string, workingDir: string): string {
  const envPrompt = `

# Current Environment Context
- Current working directory (CWD): ${workingDir}
- Operating System: ${process.platform}
- Home directory: ${process.env.HOME || process.env.USERPROFILE || ""}
- All file operations (Read, Write, Edit, LS, etc.) should be performed within or relative to the current working directory (${workingDir}) unless an absolute path elsewhere is explicitly requested by the user.
- NEVER guess paths or assume the codebase is located in directories like '/Users/eric/DeepSeek-code', '/Users/liang/deepseek-code', or similar unless they match the actual CWD provided above.
- If you need to explore files or directories, start by listing the contents of the current working directory (${workingDir}) using the LS tool with path "." or the Glob tool with "*".
- Verify that a directory or file exists before trying to access it. If you get a "no such file or directory" error, do not guess another directory; check your assumptions, locate the file relative to the CWD, or ask the user for clarification.`;
  return `${systemPrompt}${envPrompt}`;
}
