
























import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "Notification";

export interface HookCommand {
  type: "command";
  command: string;
}

export interface HookGroup {
  matcher?: string; 
  hooks?: HookCommand[];
}

export type HooksConfig = Partial<Record<HookEvent, HookGroup[]>>;


const DATA_DIR = process.env.DEEPSEEK_CONFIG_DIR ?? join(homedir(), ".deepseek-code");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

export function loadHooks(): HooksConfig {
  try {
    if (!existsSync(SETTINGS_FILE)) return {};
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    const h = (parsed as { hooks?: unknown })?.hooks;
    return h && typeof h === "object" ? (h as HooksConfig) : {};
  } catch {
    return {};
  }
}

function matcherHits(matcher: string | undefined, name: string): boolean {
  if (!matcher || matcher === "*" || matcher === "") return true;
  return matcher
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .includes(name.toLowerCase());
}

function commandsFor(event: HookEvent, toolName?: string): string[] {
  const groups = loadHooks()[event] || [];
  const out: string[] = [];
  for (const g of groups) {
    if (toolName && !matcherHits(g.matcher, toolName)) continue;
    if (g.hooks) for (const h of g.hooks) if (h.type === "command") out.push(h.command);
  }
  return out;
}

export interface HookPayload {
  event: HookEvent;
  cwd: string;
  tool?: string;
  input?: unknown;
  output?: string;
  prompt?: string;
  notification?: string;
  sessionId?: string;
}

interface HookOutcome {
  stdout: string;
  exitCode: number | null;
}


function runOne(command: string, payload: HookPayload, timeoutMs = 10_000): Promise<HookOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const child = spawn(command, {
        shell: true,
        cwd: payload.cwd,
        env: { ...process.env, DEEPSEEK_HOOK_EVENT: payload.event },
      });
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", () => {
        
      });
      const done = (code: number | null) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, exitCode: code });
      };
      child.on("error", () => done(null));
      child.on("close", done);
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(payload));
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          
        }
        done(null);
      }, timeoutMs);
    } catch {
      resolve({ stdout, exitCode: null });
    }
  });
}

function interpretPre(out: HookOutcome): { blocked: boolean; reason?: string } {
  
  if (out.exitCode === 2) {
    return { blocked: true, reason: out.stdout.trim() || "blocked by PreToolUse hook (exit 2)" };
  }
  
  const text = out.stdout.trim();
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const decision =
        (j["decision"] as string | undefined) ??
        (j["hookSpecificOutput"] as Record<string, unknown> | undefined)?.["permissionDecision"] as string | undefined ??
        (j["permissionDecision"] as string | undefined);
      if (decision === "block" || decision === "deny") {
        const reason =
          (j["reason"] as string | undefined) ??
          (j["message"] as string | undefined) ??
          "blocked by PreToolUse hook";
        return { blocked: true, reason };
      }
    } catch {
      
    }
  }
  return { blocked: false };
}


export async function runPreToolUse(
  toolName: string,
  input: unknown,
  cwd: string,
  sessionId?: string,
): Promise<{ blocked: boolean; reason?: string }> {
  const cmds = commandsFor("PreToolUse", toolName);
  for (const cmd of cmds) {
    const out = await runOne(cmd, { event: "PreToolUse", tool: toolName, input, cwd, sessionId });
    const res = interpretPre(out);
    if (res.blocked) return res;
  }
  return { blocked: false };
}


export function runHooksFireAndForget(event: HookEvent, payload: Omit<HookPayload, "event">): void {
  const cmds = commandsFor(event, payload.tool);
  for (const cmd of cmds) {
    runOne(cmd, { ...payload, event }).catch(() => {
      
    });
  }
}
