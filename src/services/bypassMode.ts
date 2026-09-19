/**
 * When this process is allowed to stop asking for permission.
 *
 * "Skip every prompt" is the one setting in the app that removes the only
 * thing standing between the model and the host, so it has always been gated:
 * `assertBypassSafe` refuses `--dangerously-skip-permissions` — and headless
 * `--print`, which auto-approves everything — when the process is root or sudo
 * outside a sandbox. What that gate could not see was the *other* way in.
 * Shift+Tab cycles the permission modes, and `bypassPermissions` was simply
 * the fourth entry in that cycle, reachable by four keypresses in a process
 * that started with the flag off: root on a host, in the TUI the gate had just
 * declined to protect, one key away from unrestricted execution.
 *
 * So the rule lives here, and both callers ask it. The cycle's bypass entry is
 * now conditional on the same grant the startup check validates, which means
 * the two cannot drift: there is no path that unlocks bypass without having
 * passed the check that exists to lock it.
 */
import { existsSync, readFileSync } from "fs";

/** The four modes the UI can be in, in the order Shift+Tab walks them. */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** The grant, as it is carried around: the CLI flag, the config file, the
 *  persisted setting, or `false` in the absence of any of them. */
export interface BypassGrant {
  dangerouslySkipPermissions?: boolean;
}

export function isRunningAsRoot(): boolean {
  if (typeof process.getuid === "function" && process.getuid() === 0) return true;
  if (process.env.SUDO_UID !== undefined || process.env.SUDO_USER !== undefined) return true;
  return false;
}

export function isInContainer(): boolean {
  if (existsSync("/.dockerenv")) return true;
  if (process.env.container) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
    if (/docker|containerd|kubepods|lxc/.test(cgroup)) return true;
  } catch {
    // No /proc (not Linux), or unreadable: "not a container" is the safe
    // answer, because it keeps the gate closed.
  }
  return false;
}

/** Whether the grant may be exercised *here* — the same question the startup
 *  check asks, in the form a keypress handler can ask it without exiting. */
export function bypassIsPermitted(): boolean {
  return !isRunningAsRoot() || isInContainer();
}

/**
 * Refuse to start when this process was handed the bypass and must not use it.
 *
 * A startup check rather than a runtime one: the point is that the user finds
 * out before the agent has done anything, not halfway through a task when it
 * tries its first write. Both grants go through it — the flag and headless
 * `--print`, which auto-approves every tool call and used to skip the check
 * entirely because the check keyed off the flag alone.
 */
export function assertBypassSafe(config: BypassGrant, headless: boolean): void {
  if (!config.dangerouslySkipPermissions && !headless) return;
  if (bypassIsPermitted()) return;

  const why = config.dangerouslySkipPermissions
    ? "--dangerously-skip-permissions"
    : "--print (headless mode auto-approves every tool call)";
  console.error(
    `\n  Refusing to run with ${why} as root/sudo outside a sandbox.\n` +
      "  That would let the agent execute arbitrary commands unrestricted as root on your host.\n\n" +
      "  Options:\n" +
      "    • Run as a non-root user.\n" +
      "    • Run inside a container/sandbox (detected automatically).\n" +
      "    • Drop the flag and approve commands individually.\n" +
      (config.dangerouslySkipPermissions
        ? "    • If it is persisted rather than passed on the command line, clear the\n" +
          "      key from ~/.deepseek-code/settings.json or .deepseek-code.json.\n"
        : ""),
  );
  process.exit(1);
}

/**
 * The cycle Shift+Tab walks, given the grant this process is holding.
 *
 * `bypassPermissions` is in it only when the grant is held *and* the process
 * is allowed to exercise it, which is the whole point: the mode is reachable
 * exactly when the startup check let the process run with it. A user who never
 * asked for it cannot arrive there by pressing a key four times, and the mode's
 * absence from the cycle is the visible form of the gate rather than a refusal
 * they would have to trigger to discover.
 *
 * The grant is checked here rather than at the call site so the two cannot
 * disagree — this is the only way the TUI can enter the mode, and it asks the
 * same predicate `assertBypassSafe` does.
 *
 * A caller that loses the grant mid-session falls back to `default`: the index
 * lookup misses, and `default` is where a session that cannot bypass belongs.
 */
export function permissionModeCycle(grant: BypassGrant): PermissionMode[] {
  const cycle: PermissionMode[] = ["default", "acceptEdits", "plan"];
  if (grant.dangerouslySkipPermissions && bypassIsPermitted()) cycle.push("bypassPermissions");
  return cycle;
}

/** Where a session starts. The same question as the cycle's, so a process that
 *  may not exercise the grant never spends its first turn in the mode. */
export function initialPermissionMode(grant: BypassGrant): PermissionMode {
  return permissionModeCycle(grant).includes("bypassPermissions") ? "bypassPermissions" : "default";
}
