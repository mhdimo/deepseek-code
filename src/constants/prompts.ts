// Modular, dynamic system-prompt builder for DeepSeek Code.
//
// Adapted from Claude Code's src/constants/prompts.ts (computeSimpleEnvInfo +
// getSystemPrompt), but stripped of Anthropic-specific concerns (prompt-cache
// boundary markers, model-family IDs, knowledge cutoffs, undercover/ant flags,
// output styles, scratchpad, proactive/tick mode). This is the DeepSeek
// equivalent: a pure-TS function that assembles a system prompt from detected
// environment (OS/platform via node:os, cwd, current git branch via
// `git rev-parse --abbrev-ref HEAD`, today's date) + the active tool name list
// + an agent identity string.
//
// The integrator (agentSession.ts) should call assembleSystemPrompt() instead
// of the old static buildSystemInstructions() string from utils/toolUtils.ts.
// The agent's base systemPrompt (from services/agent/index.ts) is passed in as
// `identity` so the env/tool context is appended uniformly across all agents.
//
// Pure TS — no C++ backend changes. The C++ Session still owns conversation
// history + auto-compaction; we only build the static instructions string that
// is handed to `new Agent({ instructions })` once per session.

import { type as osType, release as osRelease, homedir } from "os";
import { platform } from "node:process";
import type { Tool } from "../Tool.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Inputs to assembleSystemPrompt. All optional except the agent identity. */
export interface AssembleSystemPromptOptions {
  /** The agent's base system prompt / identity (e.g. the `code` agent's systemPrompt). */
  identity: string;
  /** Override platform string. Defaults to process.platform. */
  platform?: string;
  /** Override the working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Pre-resolved current git branch. If omitted, it is detected via git. */
  gitBranch?: string;
  /** Override today's date (ISO yyyy-mm-dd). Defaults to the current date. */
  date?: string;
  /** Active tools. Their names are listed for the model. */
  tools?: readonly Tool[];
  /** Model id, surfaced in the env block so the model knows what it is. */
  model?: string;
}

// ─── Environment detection ────────────────────────────────────────────────────

/**
 * OS version line, mirroring `uname -sr` on POSIX. On Windows there is no
 * uname, so we fall back to os.version() + os.release() for a friendlier
 * string. Adapted from Claude Code's getUnameSR().
 */
export function getOsVersionLine(): string {
  if (platform === "win32") {
    // os.version() gives "Windows 11 Pro" on Windows; pair with release.
    return `${osRelease()}`;
  }
  // os.type() + os.release() wrap uname(3) on POSIX: "Darwin 25.3.0", etc.
  return `${osType()} ${osRelease()}`;
}

/**
 * Detect the current git branch via `git rev-parse --abbrev-ref HEAD`.
 * Uses Bun.spawn (per DeepSeek conventions) and never throws — returns null if
 * the directory is not a git repo or git is unavailable. A 5-second cap
 * prevents a wedged git from blocking session creation.
 */
export async function detectGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn({
      cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Guard against a wedged git hanging session creation.
    const exitTimeout = new Promise<{ code: number | null }>((resolve) =>
      setTimeout(() => resolve({ code: -1 }), 5000),
    );
    const exit = await Promise.race([
      proc.exited.then((code) => ({ code })),
      exitTimeout,
    ]);
    if (exit.code !== 0) {
      try {
        await proc.kill();
      } catch {
        /* already exited */
      }
      return null;
    }

    const stdout = new Response(proc.stdout).text();
    const branch = (await stdout).trim();
    // detached/HEAD shows as "HEAD" — treat as no meaningful branch name.
    return branch.length > 0 && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Today's date as an ISO yyyy-mm-dd string in the local timezone. Kept separate
 * so callers/tests can inject a fixed date.
 */
export function todayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ─── Section builders ────────────────────────────────────────────────────────

/**
 * Shell info line. Detects zsh/bash from $SHELL, with a Windows note telling
 * the model to prefer Unix shell syntax. Adapted from Claude Code's
 * getShellInfoLine().
 */
function getShellInfoLine(): string {
  const shell = process.env.SHELL || "unknown";
  const shellName = shell.includes("zsh")
    ? "zsh"
    : shell.includes("bash")
      ? "bash"
      : shell;
  if (platform === "win32") {
    return `Shell: ${shellName} (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)`;
  }
  return `Shell: ${shellName}`;
}

/**
 * Build the "# Environment" section: cwd, git branch, platform, OS version,
 * shell, model, date. This is the dynamic, per-session context that the old
 * buildSystemInstructions() only partially provided (it had cwd + platform but
 * missed branch, OS version, shell, and date).
 */
export function buildEnvironmentSection(opts: {
  cwd: string;
  platform: string;
  gitBranch: string | null;
  osVersion: string;
  model?: string;
  date: string;
}): string {
  const { cwd, platform: pltf, gitBranch, osVersion, model, date } = opts;

  const items: Array<string | string[]> = [
    `Working directory: ${cwd}`,
    gitBranch ? `Current git branch: ${gitBranch}` : null,
    `Is directory a git repo: ${gitBranch !== null ? "Yes" : "No"}`,
    `Platform: ${pltf}`,
    getShellInfoLine(),
    `OS Version: ${osVersion}`,
    model ? `Model: ${model}` : null,
    `Today's date: ${date}`,
  ].filter((item) => item !== null) as Array<string | string[]>;

  const bullets = items.flatMap((item) =>
    Array.isArray(item) ? item.map((s) => `  - ${s}`) : [` - ${item}`],
  );

  return [`# Environment`, `You are running in the following environment:`, ...bullets].join("\n");
}

/**
 * Build the "# Available tools" section: a comma-separated list of the active
 * tool names. Listing them reinforces what the model may call and helps it
 * avoid hallucinating tools that aren't registered.
 */
export function buildToolsSection(tools: readonly Tool[]): string | null {
  if (tools.length === 0) return null;
  const names = tools.map((t) => t.name);
  return [`# Available tools`, ` - ${names.join(", ")}`].join("\n");
}

/**
 * Build the operating-guidance section that anchors the model to the actual
 * CWD and forbids path hallucination. This carries over the load-bearing
 * anti-hallucination rules from the old buildSystemInstructions() env block —
 * they are critical (see commit 1b07963 "guard against home-path
 * hallucination").
 */
function buildOperatingRulesSection(cwd: string): string {
  const home = homedir() || "";
  return `# Operating context
 - All file operations (Read, Write, Edit, LS, etc.) must be performed within or relative to the current working directory (${cwd}) unless an absolute path elsewhere is explicitly requested by the user.
 - NEVER guess paths or assume the codebase lives in a hardcoded directory. Do not invent home directories or usernames${home ? ` (the real home is ${home})` : ""}; if you need the home dir, use $HOME or os.homedir(), never a name like "/Users/someone".
 - If you need to explore, start by listing the current working directory (${cwd}) with the LS tool (path ".") or the Glob tool (pattern "*").
 - Verify that a file or directory exists before accessing it. On "no such file or directory", do not guess another directory — re-check assumptions, locate the file relative to the CWD, or ask the user.`;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Assemble the full system prompt from the agent identity + detected
 * environment + active tools.
 *
 * Order:
 *   1. identity (the agent's base systemPrompt)
 *   2. environment section (cwd, branch, OS, shell, model, date)
 *   3. available tools section
 *   4. operating-context rules (path anti-hallucination)
 *
 * Pure TS, side-effect free apart from an optional git subprocess when
 * `gitBranch` is not supplied. The integrator should call this once per
 * session creation (in agentSession.ts) and hand the result to
 * `new Agent({ instructions })`.
 */
export async function assembleSystemPrompt(
  opts: AssembleSystemPromptOptions,
): Promise<string> {
  const {
    identity,
    tools = [],
    model,
    platform: pltf = platform,
    cwd = process.cwd(),
    date = todayDate(),
  } = opts;

  const gitBranch =
    opts.gitBranch !== undefined ? opts.gitBranch : await detectGitBranch(cwd);
  const osVersion = getOsVersionLine();

  const sections: string[] = [identity.trim()];

  const envSection = buildEnvironmentSection({
    cwd,
    platform: pltf,
    gitBranch,
    osVersion,
    model,
    date,
  });
  sections.push(envSection);

  const toolsSection = buildToolsSection(tools);
  if (toolsSection) sections.push(toolsSection);

  sections.push(buildOperatingRulesSection(cwd));

  return sections.join("\n\n");
}

/**
 * Synchronous variant for callers that have already resolved the git branch
 * (or don't want one). Equivalent to assembleSystemPrompt with gitBranch
 * forced to null. Useful where the session-creation path is synchronous.
 */
export function assembleSystemPromptSync(opts: AssembleSystemPromptOptions): string {
  const {
    identity,
    tools = [],
    model,
    platform: pltf = platform,
    cwd = process.cwd(),
    date = todayDate(),
    gitBranch = null,
  } = opts;

  const osVersion = getOsVersionLine();

  const sections: string[] = [identity.trim()];

  sections.push(
    buildEnvironmentSection({
      cwd,
      platform: pltf,
      gitBranch,
      osVersion,
      model,
      date,
    }),
  );

  const toolsSection = buildToolsSection(tools);
  if (toolsSection) sections.push(toolsSection);

  sections.push(buildOperatingRulesSection(cwd));

  return sections.join("\n\n");
}
