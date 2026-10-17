/**
 * Self-update and release notes.
 *
 * `deepseek-code update` (and `/update`) asks the npm registry what the latest
 * published version is and, when it is newer, installs it with the package
 * manager that installed this copy. The TUI also checks once a day at startup
 * and says one line if there is something newer — never more than that, and
 * never a network call in a test or CI run.
 *
 * Nothing here is allowed to break the app: every network and filesystem
 * failure degrades to "could not check", which callers render as silence.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./dataDir.js";

export const PACKAGE_NAME = "@mihaldmo/deepseek-code";

/** One registry check a day is plenty for a CLI. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const UPDATE_CHECK_FILE = "update-check.json";
const UPDATE_INSTALL_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Empty for a release; e.g. ["beta", "1"] for 1.2.3-beta.1. */
  prerelease: readonly string[];
}

/** Parse `1.2.3`, `v1.2.3`, `1.2.3-beta.1` or `1.2.3+build`. Null if it is not
 *  a semantic version — registry junk must not become "an update". */
export function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim(),
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/**
 * Semver precedence, returning -1 / 0 / 1.
 *
 * Two unparseable versions compare equal: callers only ever ask "is this
 * newer?", and the safe answer to a version we cannot read is "no".
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;

  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }

  // A prerelease precedes the release it leads to: 1.0.0-beta < 1.0.0.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1; // a shorter set of identifiers is lower
    if (y === undefined) return 1;

    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (xNumeric) {
      return -1; // numeric identifiers sort before alphanumeric ones
    } else if (yNumeric) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface FetchLatestOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The latest published version, or null when the registry cannot be reached
 *  or answers with something that is not a version. */
export async function fetchLatestVersion(
  options: FetchLatestOptions = {},
): Promise<string | null> {
  const { timeoutMs = 3_000, fetchImpl = fetch } = options;
  try {
    const response = await fetchImpl(REGISTRY_LATEST_URL, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && parseVersion(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cached check
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
  checkedAt: number;
  /** True when the answer came from the on-disk cache rather than the network. */
  cached: boolean;
}

interface CachedCheck {
  current: string;
  latest: string;
  checkedAt: number;
}

export interface CheckForUpdateOptions {
  currentVersion: string;
  /** Ignore the cache — `/update` means "check now". */
  force?: boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Test seam; defaults to the app's data directory. */
  dataDirPath?: string;
  intervalMs?: number;
}

function readCachedCheck(path: string): CachedCheck | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CachedCheck>;
    if (
      typeof parsed.current === "string" &&
      typeof parsed.latest === "string" &&
      typeof parsed.checkedAt === "number" &&
      parseVersion(parsed.current) &&
      parseVersion(parsed.latest)
    ) {
      return { current: parsed.current, latest: parsed.latest, checkedAt: parsed.checkedAt };
    }
  } catch {
    // Missing, unreadable, or someone else's JSON: the cache is disposable.
  }
  return null;
}

function writeCachedCheck(path: string, check: CachedCheck): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(check, null, 2));
  } catch {
    // A cache we cannot write costs one extra request next launch.
  }
}

/**
 * The update status, consulting the cache first.
 *
 * Returns null only when there is nothing useful to say: no cache and no
 * network. When the network is down but a previous answer exists, the stale
 * answer is still returned (recomputed against the version actually running)
 * so an offline user who already knows an update exists keeps being told.
 */
export async function checkForUpdate(
  options: CheckForUpdateOptions,
): Promise<UpdateCheckResult | null> {
  const {
    currentVersion,
    force = false,
    now = Date.now,
    fetchImpl = fetch,
    dataDirPath = dataDir(),
    intervalMs = UPDATE_CHECK_INTERVAL_MS,
  } = options;

  const path = join(dataDirPath, UPDATE_CHECK_FILE);
  const cached = readCachedCheck(path);
  const cacheIsFresh =
    cached !== null &&
    cached.current === currentVersion &&
    now() - cached.checkedAt < intervalMs;

  if (!force && cacheIsFresh) {
    return {
      current: currentVersion,
      latest: cached.latest,
      updateAvailable: isNewerVersion(cached.latest, currentVersion),
      checkedAt: cached.checkedAt,
      cached: true,
    };
  }

  const latest = await fetchLatestVersion({ fetchImpl });
  if (!latest) {
    if (!cached) return null;
    return {
      current: currentVersion,
      latest: cached.latest,
      updateAvailable: isNewerVersion(cached.latest, currentVersion),
      checkedAt: cached.checkedAt,
      cached: true,
    };
  }

  const checkedAt = now();
  writeCachedCheck(path, { current: currentVersion, latest, checkedAt });
  return {
    current: currentVersion,
    latest,
    updateAvailable: isNewerVersion(latest, currentVersion),
    checkedAt,
    cached: false,
  };
}

/** The startup check is a courtesy, not a requirement: tests, CI and anyone
 *  who opts out never make the request. */
export function updateCheckEnabledOnStartup(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DEEPSEEK_CODE_NO_UPDATE_CHECK === "1") return false;
  // Bun sets NODE_ENV=test in `bun test`; a rendering test must not reach the
  // network or write into the user's data directory.
  if (env.NODE_ENV === "test") return false;
  if (env.CI) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

export type InstallMethod = "npm" | "bun" | "unknown";

/**
 * Which package manager owns this copy, inferred from where it was loaded.
 *
 * The module directory is `<prefix>/node_modules/@mihaldmo/deepseek-code/dist`.
 * bun's global prefix lives under `~/.bun/install/global`, which is the only
 * reliable marker; everything else under `node_modules` is assumed to be npm.
 * pnpm and yarn get "unknown" — running an npm install over their tree would
 * leave two copies and no clean way to pick one.
 */
export function detectInstallMethod(
  moduleDir: string = import.meta.dir,
  env: NodeJS.ProcessEnv = process.env,
): InstallMethod {
  if (env.npm_config_user_agent?.startsWith("bun/")) return "bun";

  const normalized = moduleDir.replace(/\\/g, "/");
  if (!normalized.split("/").includes("node_modules")) return "unknown";
  if (/\/\.?pnpm\//.test(normalized)) return "unknown";
  if (/\/\.?yarn\//.test(normalized)) return "unknown";
  if (normalized.includes("/.bun/") || normalized.includes("/bun/install/")) return "bun";
  return "npm";
}

/** The argv for installing `version` with `method`. Unknown falls back to npm,
 *  which is the most portable spelling of the command we would print. */
export function installCommand(method: InstallMethod, version = "latest"): string[] {
  const spec = `${PACKAGE_NAME}@${version}`;
  return method === "bun" ? ["bun", "add", "-g", spec] : ["npm", "install", "-g", spec];
}

export interface UpdateRunOptions {
  version?: string;
  moduleDir?: string;
  method?: InstallMethod;
  timeoutMs?: number;
}

export interface UpdateRunResult {
  success: boolean;
  method: InstallMethod;
  /** The command as the user would type it. */
  command: string;
  /** Combined stdout and stderr, trimmed. */
  output: string;
}

/**
 * Install the latest (or a specific) version.
 *
 * This replaces the files of the process that is calling it, which is safe:
 * npm/bun write a new `node_modules` entry and relink the bin, while the
 * running Bun process keeps the code it already loaded. The caller tells the
 * user to restart for the same reason.
 */
export async function runUpdate(options: UpdateRunOptions = {}): Promise<UpdateRunResult> {
  const version = options.version ?? "latest";
  const method = options.method ?? detectInstallMethod(options.moduleDir);
  const argv = installCommand(method, version);
  const command = argv.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ");

  if (method === "unknown") {
    return {
      success: false,
      method,
      command,
      output:
        "This copy was not installed with npm or bun (it looks like a source checkout, " +
        "or pnpm/yarn owns it). Update it the way you installed it, or run the command " +
        "above yourself.",
    };
  }

  try {
    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      proc.kill();
    }, options.timeoutMs ?? UPDATE_INSTALL_TIMEOUT_MS);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return {
      success: exitCode === 0,
      method,
      command,
      output:
        exitCode === 0
          ? output
          : [output, `(${command} exited with code ${exitCode})`].filter(Boolean).join("\n"),
    };
  } catch (error) {
    return {
      success: false,
      method,
      command,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

/**
 * Where the changelog lives, relative to the running code.
 *
 * The build copies CHANGELOG.md into `dist/` so an installed package has it
 * beside index.js. Running from source instead, the repo root is two levels
 * up from `src/utils/`.
 */
export function resolveChangelogPath(
  moduleDir: string = import.meta.dir,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  const candidates = [
    join(moduleDir, "CHANGELOG.md"),
    join(moduleDir, "..", "CHANGELOG.md"),
    join(moduleDir, "..", "..", "CHANGELOG.md"),
  ];
  return candidates.find((candidate) => fileExists(candidate)) ?? null;
}

export function readChangelog(moduleDir: string = import.meta.dir): string | null {
  const path = resolveChangelogPath(moduleDir);
  if (!path) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Keep a long changelog from swallowing the transcript. */
export function formatChangelogForDisplay(text: string, maxChars = 8_000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n… (see CHANGELOG.md for the rest)`;
}
