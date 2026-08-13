



















import { type as osType, release as osRelease, homedir } from "os";
import { platform } from "node:process";
import type { Tool } from "../Tool.js";




export interface AssembleSystemPromptOptions {
  
  identity: string;
  
  platform?: string;
  
  cwd?: string;
  
  gitBranch?: string;
  
  date?: string;
  
  tools?: readonly Tool[];
  
  model?: string;
}




export function getOsVersionLine(): string {
  if (platform === "win32") {
    
    return `${osRelease()}`;
  }
  
  return `${osType()} ${osRelease()}`;
}


export async function detectGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn({
      cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    
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
        
      }
      return null;
    }

    const stdout = new Response(proc.stdout).text();
    const branch = (await stdout).trim();
    
    return branch.length > 0 && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}


export function todayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}




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


export function buildToolsSection(tools: readonly Tool[]): string | null {
  if (tools.length === 0) return null;
  const names = tools.map((t) => t.name);
  return [`# Available tools`, ` - ${names.join(", ")}`].join("\n");
}


function buildOperatingRulesSection(cwd: string): string {
  const home = homedir() || "";
  return `# Operating context
 - All file operations (Read, Write, Edit, LS, etc.) must be performed within or relative to the current working directory (${cwd}) unless an absolute path elsewhere is explicitly requested by the user.
 - NEVER guess paths or assume the codebase lives in a hardcoded directory. Do not invent home directories or usernames${home ? ` (the real home is ${home})` : ""}; if you need the home dir, use $HOME or os.homedir(), never a name like "/Users/someone".
 - If you need to explore, start by listing the current working directory (${cwd}) with the LS tool (path ".") or the Glob tool (pattern "*").
 - Verify that a file or directory exists before accessing it. On "no such file or directory", do not guess another directory — re-check assumptions, locate the file relative to the CWD, or ask the user.`;
}




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
