import { readdir, realpath, stat } from "fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { resolvePath } from "../../utils/toolUtils.js";
import { GLOB_TOOL_NAME, DESCRIPTION } from "./prompt.js";
import { checkReadAccess } from "../../services/readPermissions.js";
import { globMatcher } from "./glob.js";

const GlobInputSchema = z.object({
  pattern: z.string().describe(
    'The glob pattern to match files against (e.g. "**/*.ts" or "src/**/*.tsx")',
  ),
  path: z.string().optional().describe(
    "The directory to search in. Defaults to current working directory.",
  ),
});

/** The reference caps at 100; a match set beyond that says "narrow your search". */
const MAX_RESULTS = 100;

/** Directories never worth walking into, matching the old find exclusions. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** A wedged filesystem must not stall the agent step. */
const TIMEOUT_MS = 30_000;

interface Match {
  path: string;
  mtimeMs: number;
}

/**
 * When a supplied directory is missing, the usual cause is a path that is right
 * except for where it starts — an absolute path handed to a session running
 * somewhere else. Look for the same relative path under cwd and offer it.
 */
async function suggestUnderCwd(requested: string): Promise<string | undefined> {
  const cwd = process.cwd();
  const parent = dirname(cwd);
  // Resolve symlinks in the parent (/tmp is /private/tmp on macOS) so the
  // prefix test compares against the realpath-resolved cwd.
  let resolved = requested;
  try {
    resolved = join(await realpath(dirname(requested)), basename(requested));
  } catch {
    // Parent doesn't exist either; compare the path as given.
  }
  const parentPrefix = parent === sep ? sep : parent + sep;
  if (
    !resolved.startsWith(parentPrefix) ||
    resolved.startsWith(cwd + sep) ||
    resolved === cwd
  ) {
    return undefined;
  }
  const corrected = join(cwd, relative(parent, resolved));
  try {
    await stat(corrected);
    return corrected;
  } catch {
    return undefined;
  }
}

export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  requiredPermission: "allowRead",
  description: DESCRIPTION,
  inputSchema: GlobInputSchema,

  userFacingName: (_input) => "Glob",

  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  maxResultSizeChars: 100_000,

  // Searching outside the working directory is the user's call, not the
  // session's: see services/readPermissions.
  checkPermissions: (input, context) => checkReadAccess(GLOB_TOOL_NAME, input, context),

  call: async (input, context) => {
    const { pattern } = input;
    const dir = resolvePath(context.workingDir, input.path);
    const cwd = resolve(context.workingDir);
    const signal = context.abortController?.signal;

    const deadline = Date.now() + TIMEOUT_MS;
    const matches: Match[] = [];

    try {
      const stats = await stat(dir).catch(() => null);
      if (!stats) {
        const suggestion = await suggestUnderCwd(dir);
        return {
          data:
            `Directory does not exist: ${input.path ?? dir}. ` +
            `Note: your current working directory is ${cwd}.` +
            (suggestion ? ` Did you mean ${suggestion}?` : ""),
        };
      }
      if (!stats.isDirectory()) {
        return { data: `Path is not a directory: ${input.path ?? dir}` };
      }

      const isMatch = globMatcher(pattern);
      const pending: string[] = [dir];

      while (pending.length > 0) {
        if (signal?.aborted) return { data: "Aborted/Cancelled by user" };
        if (Date.now() > deadline) return { data: "Error: glob timed out" };

        const current = pending.pop()!;
        let entries;
        try {
          entries = await readdir(current, { withFileTypes: true });
        } catch {
          // Unreadable directory (permissions, raced deletion): skip it, the
          // way find would print to stderr and carry on.
          continue;
        }

        for (const entry of entries) {
          const full = join(current, entry.name);
          // isDirectory()/isFile() are false for symlinks, so links are not
          // followed — same as find without -L, and it rules out link cycles.
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) pending.push(full);
            continue;
          }
          if (!entry.isFile()) continue;

          const rel = relative(cwd, full);
          if (!isMatch(rel)) continue;
          const fileStats = await stat(full).catch(() => null);
          matches.push({ path: rel, mtimeMs: fileStats?.mtimeMs ?? 0 });
        }
      }

      if (matches.length === 0) {
        return { data: "No files matched the pattern." };
      }

      // Oldest first, as `rg --sort=modified` orders the reference's results.
      matches.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const truncated = matches.length > MAX_RESULTS;
      const files = matches.slice(0, MAX_RESULTS).map((m) => m.path);

      let data = files.join("\n");
      if (truncated) {
        data +=
          "\n(Results are truncated. Consider using a more specific path or pattern.)";
      }
      return { data };
    } catch (error) {
      return { data: `Error: ${(error as Error).message}` };
    }
  },
});
