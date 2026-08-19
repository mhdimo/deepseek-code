
import { spawn } from "child_process";
import { loadSettings } from "../state/storage.js";

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "Notification";

/** Canonical event order — drives the /hooks view and count enumeration. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "Notification",
];

/**
 * A single hook config as stored in settings.json. `type` selects which field
 * holds the hook content (command | prompt | http); unknown types are
 * tolerated so hand-edited files never crash the view.
 */
export interface HookConfig {
  type: string;
  command?: string;
  prompt?: string;
  url?: string;
}

export interface HookGroup {
  matcher?: string;
  /** false = kept in settings but skipped at runtime (toggled from /hooks). */
  enabled?: boolean;
  hooks?: HookConfig[];
}

export type HooksConfig = Partial<Record<HookEvent, HookGroup[]>>;

/** Events whose matcher is evaluated at runtime (matchers filter on tool name). */
export function eventSupportsMatcher(event: HookEvent): boolean {
  return event === "PreToolUse" || event === "PostToolUse";
}

/** Short label for a hook's `type`, never undefined. */
export function getHookTypeLabel(hook: HookConfig): string {
  return typeof hook.type === "string" && hook.type !== "" ? hook.type : "unknown";
}

/** Human-readable content for a hook config, keyed off its type. Never undefined. */
export function getHookDisplayText(hook: HookConfig): string {
  switch (hook.type) {
    case "command":
      return hook.command ?? "(no command)";
    case "prompt":
      return hook.prompt ?? "(no prompt)";
    case "http":
      return hook.url ?? "(no url)";
    default:
      return getHookTypeLabel(hook);
  }
}

/** Label for the primary content field of a hook, per type. */
export function getHookFieldLabel(hook: HookConfig): string {
  switch (hook.type) {
    case "command":
      return "Command";
    case "prompt":
      return "Prompt";
    case "http":
      return "URL";
    default:
      return "Content";
  }
}

/** Count configured hooks per event and in total (disabled groups included). */
export function countHooks(config: HooksConfig): {
  perEvent: Partial<Record<HookEvent, number>>;
  total: number;
} {
  const perEvent: Partial<Record<HookEvent, number>> = {};
  let total = 0;
  for (const event of HOOK_EVENTS) {
    const groups = config[event] ?? [];
    const n = groups.reduce((sum, g) => sum + (g.hooks?.length ?? 0), 0);
    perEvent[event] = n;
    total += n;
  }
  return { perEvent, total };
}

export function loadHooks(): HooksConfig {
  try {
    // Goes through loadSettings' mtime-keyed cache — this ran a second
    // synchronous file read+parse on EVERY tool invocation otherwise.
    const h = loadSettings().hooks;
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
    if (g.enabled === false) continue;
    if (toolName && !matcherHits(g.matcher, toolName)) continue;
    if (g.hooks) for (const h of g.hooks) if (h.type === "command" && h.command) out.push(h.command);
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
