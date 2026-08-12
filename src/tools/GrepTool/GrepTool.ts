// GrepTool — search for text patterns in files
//
// Rich-params grep built on ripgrep (rg) via Bun.spawn, with a graceful
// fallback to the legacy `grep -rn` implementation when rg is unavailable.
//
// Supports output_mode (content | files_with_matches | count), context lines
// (-B/-A/-C/context), count, head_limit, offset, and multiline matching.
// Read-only and concurrency-safe — every invocation spawns an isolated
// child process and never mutates the filesystem.

import { spawn } from "child_process";
import { relative, resolve } from "path";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { resolvePath } from "../../utils/toolUtils.js";
import { GREP_TOOL_NAME, DESCRIPTION } from "./prompt.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type OutputMode = "content" | "files_with_matches" | "count";

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: OutputMode;
  "-B"?: number;
  "-A"?: number;
  "-C"?: number;
  context?: number;
  "-n"?: boolean;
  "-i"?: boolean;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
  // Legacy alias kept for backwards compatibility with old callers/sessions.
  include?: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

// VCS / build directories to exclude automatically — they create noise.
const VCS_DIRECTORIES_TO_EXCLUDE = [
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl",
];

// Default cap when head_limit is unspecified. Unbounded content-mode greps can
// waste thousands of tokens in a grep-heavy session. Pass head_limit=0 for
// unlimited.
const DEFAULT_HEAD_LIMIT = 250;

// rg exit codes: 0 = matches, 1 = no matches, 2 = error.
const RG_SUCCESS_CODES = new Set([0, 1]);

// ─── Pagination helper ───────────────────────────────────────────────────────

/**
 * Apply offset + head_limit to a list of items.
 * head_limit === 0 is the explicit "unlimited" escape hatch.
 * Returns the sliced items plus the effective limit that was applied, but only
 * reports `appliedLimit` when truncation actually occurred (so the caller knows
 * there may be more results to paginate).
 */
function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined };
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT;
  const sliced = items.slice(offset, offset + effectiveLimit);
  const wasTruncated = items.length - offset > effectiveLimit;
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  };
}

function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`);
  return parts.join(", ");
}

function pluralize(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

// ─── Backend detection ───────────────────────────────────────────────────────

/**
 * Detect whether ripgrep (`rg`) is available on PATH. Memoized so the lookup
 * runs at most once per process. When false, we fall back to the legacy
 * grep -rn implementation (which loses the rich params but still works).
 */
let rgAvailableCache: boolean | null = null;
async function rgAvailable(): Promise<boolean> {
  if (rgAvailableCache !== null) return rgAvailableCache;
  try {
    const { code, stdout } = await runBun(["rg", "--version"], ".");
    rgAvailableCache = code === 0 && stdout.startsWith("ripgrep ");
  } catch {
    rgAvailableCache = false;
  }
  return rgAvailableCache;
}

// ─── Process spawning ────────────────────────────────────────────────────────

/** Run a command via Bun.spawn, capturing stdout/stderr and exit code. */
async function runBun(
  cmd: string[],
  cwd: string,
  opts?: { signal?: AbortSignal; maxBuffer?: number },
): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: opts?.signal,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** Cap an output string to avoid materializing enormous buffers. */
function capBuffer(s: string): string {
  const MAX = 20_000_000; // 20MB
  return s.length > MAX ? s.slice(0, MAX) : s;
}

// ─── ripgrep backend ─────────────────────────────────────────────────────────

/** Build the ripgrep arg vector for the given input. */
function buildRgArgs(input: GrepInput): string[] {
  const {
    pattern,
    glob,
    type,
    output_mode = "files_with_matches",
    "-B": contextBefore,
    "-A": contextAfter,
    "-C": contextC,
    context,
    "-n": showLineNumbers = true,
    "-i": caseInsensitive = false,
    include,
    multiline = false,
  } = input;

  const args: string[] = ["--hidden", "--color=never"];

  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${dir}`);
  }
  // Always exclude noisy dependency/build dirs.
  args.push("--glob", "!node_modules");
  args.push("--glob", "!dist");
  args.push("--glob", "!build");

  // Cap line length so base64/minified content doesn't blow up the result.
  args.push("--max-columns", "500");

  if (multiline) {
    args.push("-U", "--multiline-dotall");
  }
  if (caseInsensitive) {
    args.push("-i");
  }

  if (output_mode === "files_with_matches") {
    args.push("-l");
  } else if (output_mode === "count") {
    args.push("-c");
  }

  if (showLineNumbers && output_mode === "content") {
    args.push("-n");
  }

  if (output_mode === "content") {
    if (context !== undefined) {
      args.push("-C", String(context));
    } else if (contextC !== undefined) {
      args.push("-C", String(contextC));
    } else {
      if (contextBefore !== undefined) args.push("-B", String(contextBefore));
      if (contextAfter !== undefined) args.push("-A", String(contextAfter));
    }
  }

  // If pattern starts with a dash, use -e so rg doesn't treat it as an option.
  if (pattern.startsWith("-")) {
    args.push("-e", pattern);
  } else {
    args.push(pattern);
  }

  if (type) {
    args.push("--type", type);
  }

  // Glob filtering. `glob` is preferred; `include` is the legacy alias.
  const globSource = glob ?? include;
  if (globSource) {
    // Split on whitespace, then on commas (but preserve brace patterns).
    const patterns: string[] = [];
    for (const raw of globSource.split(/\s+/)) {
      if (raw.includes("{") && raw.includes("}")) {
        patterns.push(raw);
      } else {
        patterns.push(...raw.split(",").filter(Boolean));
      }
    }
    for (const p of patterns) {
      if (p) args.push("--glob", p);
    }
  }

  return args;
}

/**
 * Run a ripgrep search and return the raw output lines.
 * Rejects on critical errors (ENOENT/EACCES/EPERM); resolves [] on "no matches".
 */
async function ripgrep(
  args: string[],
  target: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const { code, stdout, stderr } = await runBun(["rg", ...args], target, {
    signal,
  });

  if (RG_SUCCESS_CODES.has(code)) {
    return capBuffer(stdout)
      .trim()
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter(Boolean);
  }

  // Exit code 2 = rg usage error (bad pattern, bad flag). Surface the message.
  if (code === 2) {
    throw new Error(
      `ripgrep error: ${stderr.trim() || stdout.trim() || "exit code 2"}`,
    );
  }
  // Anything else — treat as "no usable output" but still surface in the empty case.
  const hasOutput = stdout.trim().length > 0;
  if (!hasOutput) {
    throw new Error(
      `ripgrep exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
    );
  }
  return capBuffer(stdout)
    .trim()
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean);
}

// ─── Result formatters (ripgrep path) ────────────────────────────────────────

function renderContent(
  lines: string[],
  cwd: string,
  head_limit: number | undefined,
  offset: number | undefined,
): string {
  const off = offset ?? 0;
  const { items, appliedLimit } = applyHeadLimit(lines, head_limit, off);

  const relativized = items.map((line) => relativizeContentLine(line, cwd));
  const body = relativized.join("\n") || "No matches found.";
  const limitInfo = formatLimitInfo(appliedLimit, off > 0 ? off : undefined);
  return limitInfo
    ? `${body}\n\n[Showing results with pagination = ${limitInfo}]`
    : body;
}

/** rg content lines look like `/abs/path:NUM:content` or `/abs/path:content`. */
function relativizeContentLine(line: string, cwd: string): string {
  const colonIdx = line.indexOf(":");
  if (colonIdx <= 0) return line;
  const filePath = line.slice(0, colonIdx);
  const rest = line.slice(colonIdx);
  const rel = safeRelative(cwd, filePath);
  return `${rel}${rest}`;
}

function renderCount(
  lines: string[],
  cwd: string,
  head_limit: number | undefined,
  offset: number | undefined,
): { text: string; totalMatches: number; fileCount: number } {
  const off = offset ?? 0;
  const { items, appliedLimit } = applyHeadLimit(lines, head_limit, off);

  let totalMatches = 0;
  let fileCount = 0;
  const rendered = items.map((line) => {
    // Format: /abs/path:count
    const colonIdx = line.lastIndexOf(":");
    if (colonIdx <= 0) return line;
    const filePath = line.slice(0, colonIdx);
    const countPart = line.slice(colonIdx);
    const countStr = line.slice(colonIdx + 1);
    const count = parseInt(countStr, 10);
    if (!Number.isNaN(count)) {
      totalMatches += count;
      fileCount += 1;
    }
    return `${safeRelative(cwd, filePath)}${countPart}`;
  });

  const body = rendered.join("\n") || "No matches found.";
  const limitInfo = formatLimitInfo(appliedLimit, off > 0 ? off : undefined);
  const summary = `\n\nFound ${totalMatches} ${pluralize(
    totalMatches,
    "occurrence",
  )} across ${fileCount} ${pluralize(fileCount, "file")}${
    limitInfo ? ` with pagination = ${limitInfo}` : ""
  }`;
  return { text: body + summary, totalMatches, fileCount };
}

function renderFilesWithMatches(
  lines: string[],
  cwd: string,
  head_limit: number | undefined,
  offset: number | undefined,
): string {
  const off = offset ?? 0;
  const { items, appliedLimit } = applyHeadLimit(lines, head_limit, off);
  const rels = items.map((p) => safeRelative(cwd, p));

  if (rels.length === 0) return "No files found";

  const limitInfo = formatLimitInfo(appliedLimit, off > 0 ? off : undefined);
  const header = `Found ${rels.length} ${pluralize(
    rels.length,
    "file",
  )}${limitInfo ? ` ${limitInfo}` : ""}`;
  return `${header}\n${rels.join("\n")}`;
}

/** Relative path that never throws (falls back to the original on failure). */
function safeRelative(cwd: string, absPath: string): string {
  try {
    const rel = relative(cwd, absPath);
    return rel || absPath;
  } catch {
    return absPath;
  }
}

// ─── Legacy grep fallback ────────────────────────────────────────────────────
//
// Used only when ripgrep is unavailable. Does not support the rich params
// (context/-B/-A/-C/count/multiline); those are simply ignored. output_mode is
// approximated: files_with_matches via -l, count via -c, content via -n.

const MAX_MATCH_LINES = 100;

function grepFallback(
  input: GrepInput,
  dir: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const {
    pattern,
    output_mode = "files_with_matches",
    "-i": caseInsensitive = false,
    include,
    glob,
  } = input;
  const globSource = glob ?? include;

  const args = ["--color=never", "-E"];
  if (caseInsensitive) args.push("-i");
  if (output_mode === "files_with_matches") {
    args.push("-rl");
  } else if (output_mode === "count") {
    args.push("-rc");
  } else {
    args.push("-rn");
  }
  args.push(pattern, dir);
  for (const d of ["node_modules", ".git", "dist"]) {
    args.push(`--exclude-dir=${d}`);
  }
  if (globSource) {
    // Comma-separated globs: split and apply each.
    for (const g of globSource.split(/[,\s]+/).filter(Boolean)) {
      args.push(`--include=${g}`);
    }
  }

  return new Promise<string>((resolvePromise) => {
    const child = spawn("grep", args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });

    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });

    child.on("close", () => {
      const lines = out.trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        resolvePromise(
          output_mode === "files_with_matches"
            ? "No files found"
            : "No matches found.",
        );
        return;
      }

      if (output_mode === "count") {
        let total = 0;
        let files = 0;
        const rendered = lines.map((l) => {
          const ci = l.lastIndexOf(":");
          const c = parseInt(l.slice(ci + 1), 10);
          if (!Number.isNaN(c)) {
            total += c;
            files += 1;
          }
          return `${safeRelative(cwd, l.slice(0, ci))}${l.slice(ci)}`;
        });
        resolvePromise(
          `${rendered.join("\n")}\n\nFound ${total} ${pluralize(
            total,
            "occurrence",
          )} across ${files} ${pluralize(files, "file")}`,
        );
        return;
      }

      const results = lines
        .slice(0, MAX_MATCH_LINES)
        .map((l) => {
          const colonIdx = l.indexOf(":");
          if (colonIdx === -1) return l;
          const filePart = l.slice(0, colonIdx);
          const rest = l.slice(colonIdx + 1);
          return `${safeRelative(cwd, filePart)}:${rest}`;
        })
        .join("\n");

      if (lines.length > MAX_MATCH_LINES) {
        resolvePromise(
          `${results}\n... (${
            lines.length - MAX_MATCH_LINES
          } more matches). NOTE: ripgrep unavailable, rich params ignored.`,
        );
      } else {
        resolvePromise(results);
      }
    });

    child.on("error", () => {
      resolvePromise("Error: neither ripgrep nor grep is available");
    });
  });
}

// ─── Input schema ────────────────────────────────────────────────────────────

const GrepInputSchema = z.object({
  pattern: z.string().describe(
    "The regular expression pattern to search for in file contents",
  ),
  path: z.string().optional().describe(
    "File or directory to search in (rg PATH). Defaults to current working directory.",
  ),
  glob: z.string().optional().describe(
    'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") — maps to rg --glob.',
  ),
  type: z.string().optional().describe(
    "File type to search (rg --type). Common types: js, ts, py, rust, go, java. More efficient than glob for standard types.",
  ),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe(
      'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (default), "count" shows per-file match counts. Defaults to "files_with_matches".',
    ),
  "-B": z
    .number()
    .optional()
    .describe(
      'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
    ),
  "-A": z
    .number()
    .optional()
    .describe(
      'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
    ),
  "-C": z.number().optional().describe("Alias for context."),
  context: z
    .number()
    .optional()
    .describe(
      'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
    ),
  "-n": z
    .boolean()
    .optional()
    .describe(
      'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
    ),
  "-i": z
    .boolean()
    .optional()
    .describe("Case-insensitive search (rg -i). Default: false."),
  head_limit: z
    .number()
    .optional()
    .describe(
      'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes. Defaults to 250. Pass 0 for unlimited (use sparingly — large result sets waste context).',
    ),
  offset: z
    .number()
    .optional()
    .describe(
      "Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0.",
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
    ),
  // Legacy alias retained for backwards compatibility with older callers.
  include: z
    .string()
    .optional()
    .describe(
      'Legacy alias for glob. File glob to filter by (e.g. "*.js" or "*.{ts,tsx}"). Prefer glob.',
    ),
});

// ─── Tool definition ─────────────────────────────────────────────────────────

export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: GrepInputSchema,

  userFacingName: (_input) => "Grep",

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
    const cwd = resolve(context.workingDir);
    const dir = resolvePath(context.workingDir, input.path);
    const output_mode: OutputMode = input.output_mode ?? "files_with_matches";
    const signal = context.abortController?.signal;

    // ── ripgrep path (preferred) ──────────────────────────────────────────
    if (await rgAvailable()) {
      try {
        const args = buildRgArgs(input);
        const lines = await ripgrep(args, dir, signal);

        if (output_mode === "content") {
          return { data: renderContent(lines, cwd, input.head_limit, input.offset) };
        }
        if (output_mode === "count") {
          return { data: renderCount(lines, cwd, input.head_limit, input.offset).text };
        }
        return { data: renderFilesWithMatches(lines, cwd, input.head_limit, input.offset) };
      } catch (error) {
        // If rg failed for a structural reason (bad pattern, ENOENT on target),
        // surface the error rather than silently degrading to grep.
        const msg = (error as Error).message || "";
        // Distinguish "target path missing" / "bad pattern" from a transient rg issue.
        if (/exit code 2|ENOENT|EACCES|EPERM/i.test(msg)) {
          return { data: `Error: ${msg}` };
        }
        // Otherwise fall through to the grep fallback below.
      }
    }

    // ── grep fallback (rg unavailable or transient rg failure) ────────────
    try {
      return { data: await grepFallback(input, dir, cwd, signal) };
    } catch (error) {
      return { data: `Error: ${(error as Error).message}` };
    }
  },
});
