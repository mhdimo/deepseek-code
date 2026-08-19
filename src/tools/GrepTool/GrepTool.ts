









import { spawn } from "child_process";
import { relative, resolve } from "path";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { resolvePath } from "../../utils/toolUtils.js";
import { GREP_TOOL_NAME, DESCRIPTION } from "./prompt.js";



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
  
  include?: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}




const VCS_DIRECTORIES_TO_EXCLUDE = [
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl",
];




const DEFAULT_HEAD_LIMIT = 250;


const RG_SUCCESS_CODES = new Set([0, 1]);




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




async function runBun(
  cmd: string[],
  cwd: string,
  opts?: { signal?: AbortSignal; maxBuffer?: number; timeoutMs?: number; lineBudget?: number },
): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: opts?.signal,
  });
  const timeout = opts?.timeoutMs;
  const timer = timeout
    ? setTimeout(() => {
        try {
          proc.kill();
        } catch {
          
        }
      }, timeout)
    : null;
  try {
    // Stream stdout with a hard byte cap and an optional line budget:
    // buffering the ENTIRE rg output before capping (the old behavior)
    // spiked hundreds of MB on broad searches. Kill rg once the budget
    // is satisfied — the caller only keeps head_limit lines anyway.
    const MAX = opts?.maxBuffer ?? 20_000_000;
    const lineBudget = opts?.lineBudget ?? 0;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let stdout = "";
    let capped = false;
    let done = false;
    let lines = 0;
    for (;;) {
      const read = await reader.read();
      done = read.done;
      if (done) break;
      stdout += decoder.decode(read.value, { stream: true });
      if (stdout.length > MAX) {
        capped = true;
        stdout = stdout.slice(0, MAX);
        break;
      }
      if (lineBudget > 0) {
        lines += countNewlines(read.value!);
        if (lines >= lineBudget) break;
      }
    }
    if (!done && (capped || (lineBudget > 0 && lines >= lineBudget))) {
      try {
        proc.kill();
      } catch {
        
      }
    }
    stdout += decoder.decode();
    const [stderr] = await Promise.all([
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function countNewlines(buf: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) n++;
  }
  return n;
}


function capBuffer(s: string): string {
  const MAX = 20_000_000; 
  return s.length > MAX ? s.slice(0, MAX) : s;
}




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
  
  args.push("--glob", "!node_modules");
  args.push("--glob", "!dist");
  args.push("--glob", "!build");

  
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

  
  if (pattern.startsWith("-")) {
    args.push("-e", pattern);
  } else {
    args.push(pattern);
  }

  if (type) {
    args.push("--type", type);
  }

  
  const globSource = glob ?? include;
  if (globSource) {
    
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


async function ripgrep(
  args: string[],
  target: string,
  signal?: AbortSignal,
  lineBudget?: number,
): Promise<string[]> {
  const { code, stdout, stderr } = await runBun(["rg", ...args], target, {
    signal,
    // A hung rg (huge tree, wedged filesystem) must not stall the whole
    // agent step forever — 20s matches the reference ripgrep timeout.
    timeoutMs: 20_000,
    // Kill rg once we've collected enough result lines for -l/-c modes
    // (each line is one file/count) instead of letting it walk the whole
    // tree — the caller only keeps head_limit entries anyway.
    lineBudget,
  });

  if (RG_SUCCESS_CODES.has(code)) {
    return capBuffer(stdout)
      .trim()
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter(Boolean);
  }

  
  if (code === 2) {
    throw new Error(
      `ripgrep error: ${stderr.trim() || stdout.trim() || "exit code 2"}`,
    );
  }
  
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


function safeRelative(cwd: string, absPath: string): string {
  try {
    const rel = relative(cwd, absPath);
    return rel || absPath;
  } catch {
    return absPath;
  }
}







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
  
  include: z
    .string()
    .optional()
    .describe(
      'Legacy alias for glob. File glob to filter by (e.g. "*.js" or "*.{ts,tsx}"). Prefer glob.',
    ),
});



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

    
    if (await rgAvailable()) {
      try {
        const args = buildRgArgs(input);
        // In -l/-c modes every output line is one result, so rg can be
        // killed once head_limit + offset lines arrived (renderers only
        // keep that many anyway). Content mode lines carry context, so no
        // line budget there — the byte cap still applies.
        const budget =
          output_mode !== "content" && (input.head_limit ?? DEFAULT_HEAD_LIMIT) !== 0
            ? (input.head_limit ?? DEFAULT_HEAD_LIMIT) + (input.offset ?? 0)
            : undefined;
        const lines = await ripgrep(args, dir, signal, budget);

        if (output_mode === "content") {
          return { data: renderContent(lines, cwd, input.head_limit, input.offset) };
        }
        if (output_mode === "count") {
          return { data: renderCount(lines, cwd, input.head_limit, input.offset).text };
        }
        return { data: renderFilesWithMatches(lines, cwd, input.head_limit, input.offset) };
      } catch (error) {
        
        
        const msg = (error as Error).message || "";
        
        if (/exit code 2|ENOENT|EACCES|EPERM/i.test(msg)) {
          return { data: `Error: ${msg}` };
        }
        
      }
    }

    
    try {
      return { data: await grepFallback(input, dir, cwd, signal) };
    } catch (error) {
      return { data: `Error: ${(error as Error).message}` };
    }
  },
});
