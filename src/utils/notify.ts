// Native desktop notifications + power management.
//
// Adapted from Claude Code's `services/notifier.ts` and
// `services/preventSleep.ts`, but reworked for DeepSeek's patterns:
//   - Pure TS utility (no hooks/analytics/terminal-OSC layers from Claude).
//   - Uses Bun.spawn (per DeepSeek conventions) instead of Node child_process.
//   - Defensive everywhere: a missing binary or a non-zero exit never throws.
//   - Platform-detected dispatch: macOS (osascript), Linux (notify-send),
//     Windows (toast via PowerShell), with a terminal-bell fallback.
//
// The C++ backend owns the agent loop / streaming / compaction, so this module
// is intentionally side-effect-light and callable from anywhere on the TS side
// (system-prompt assembly, App.tsx event handlers, etc.).

// ─── Platform detection ─────────────────────────────────────────────────────

export type Platform = "macos" | "linux" | "windows" | "other";

export function detectPlatform(): Platform {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
    case "freebsd":
    case "openbsd":
      return "linux";
    default:
      return "other";
  }
}

const PLATFORM: Platform = detectPlatform();

// ─── Subprocess helper ──────────────────────────────────────────────────────

/**
 * Run a command via Bun.spawn and resolve to true on exit code 0.
 * Never throws — any spawn failure, timeout, or non-zero exit resolves false.
 * `timeoutMs` (default 8s) guards against a wedged binary hanging the caller.
 */
async function runOk(
  cmd: string[],
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const { timeoutMs = 8000 } = opts;
  try {
    const proc = Bun.spawn({
      cmd,
      stdout: "ignore",
      stderr: "ignore",
    });

    const timeout = new Promise<{ code: number | null }>((resolve) =>
      setTimeout(() => resolve({ code: null }), timeoutMs),
    );
    const exit = await Promise.race([
      proc.exited.then((code) => ({ code })),
      timeout,
    ]);

    if (exit.code === null) {
      // Timed out — best-effort kill.
      try {
        await proc.kill();
      } catch {
        /* already gone */
      }
      return false;
    }
    return exit.code === 0;
  } catch {
    // ENOENT (binary missing) or spawn rejection — treat as not-available.
    return false;
  }
}

/** Escape a string for safe interpolation into a shell argument. */
function shellQuote(s: string): string {
  // Single-quote and escape embedded single-quotes for the shell.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── Native desktop notification ─────────────────────────────────────────────

const DEFAULT_TITLE = "DeepSeek Code";

export interface NotifyOptions {
  /** Notification body text (required). */
  body: string;
  /** Notification title. Defaults to "DeepSeek Code". */
  title?: string;
  /**
   * If true, also write an ASCII BEL (\x07) to stdout so supported terminals
   * ring their bell / flash their tab. Useful when the user is in another
   * terminal tab. Default false.
   */
  bell?: boolean;
}

/**
 * Show a native desktop notification.
 *
 * Platform dispatch:
 *   - macOS:     `osascript -e 'display notification ...'`
 *   - Linux:     `notify-send`
 *   - Windows:   toast via PowerShell (BurntToast if present, else a basic
 *                [System.Windows.Forms.NotificationIcon] balloon)
 *
 * Returns true if the notification was delivered to a backend, false otherwise
 * (binary missing, non-zero exit, unsupported platform). Never throws.
 */
export async function notify(
  title: string | NotifyOptions,
  body?: string,
): Promise<boolean> {
  const opts: NotifyOptions =
    typeof title === "string"
      ? { title, body: body ?? "" }
      : { ...title, body: title.body };

  const t = opts.title?.trim() || DEFAULT_TITLE;
  const b = opts.body ?? "";

  if (opts.bell) {
    ringBell();
  }

  let delivered = false;
  try {
    switch (PLATFORM) {
      case "macos":
        delivered = await notifyMacOS(t, b);
        break;
      case "linux":
        delivered = await notifyLinux(t, b);
        break;
      case "windows":
        delivered = await notifyWindows(t, b);
        break;
      default:
        delivered = false;
    }
  } catch {
    delivered = false;
  }

  // If no native backend fired, fall back to a terminal bell so the user at
  // least gets a signal.
  if (!delivered && !opts.bell) {
    ringBell();
  }
  return delivered;
}

async function notifyMacOS(title: string, body: string): Promise<boolean> {
  // `display notification` is available on macOS 10.9+. The title is set via
  // the `title` argument; the body via the notification text itself.
  const script =
    `display notification ${shellQuote(body)} ` +
    `with title ${shellQuote(title)}`;
  return runOk(["osascript", "-e", script]);
}

async function notifyLinux(title: string, body: string): Promise<boolean> {
  // notify-send: -i '' avoids a default icon; --expire-time caps display.
  return runOk([
    "notify-send",
    "--app-name=DeepSeek Code",
    "--icon=",
    "--expire-time=8000",
    title,
    body,
  ]);
}

async function notifyWindows(title: string, body: string): Promise<boolean> {
  // Try BurntToast first (common community module); fall back to a balloon
  // via System.Windows.Forms, which is always present in Windows PowerShell.
  // We attempt BurntToast, and if it fails, attempt the balloon.
  const burntToast =
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `try { ` +
    `New-BurntToastNotification -Text ${psQuote(title)}, ${psQuote(body)}; ` +
    `} catch { exit 2 }`;
  if (await runOk(["powershell", "-NoProfile", "-Command", burntToast])) {
    return true;
  }

  const balloon =
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `$n = New-Object System.Windows.Forms.NotifyIcon; ` +
    `$n.Icon = [System.Drawing.SystemIcons]::Information; ` +
    `$n.BalloonTipTitle = ${psQuote(title)}; ` +
    `$n.BalloonTipText = ${psQuote(body)}; ` +
    `$n.Visible = $true; ` +
    `$n.ShowBalloonTip(5000); ` +
    `Start-Sleep -Seconds 6; ` +
    `$n.Dispose();`;
  return runOk(["powershell", "-NoProfile", "-Command", balloon], {
    // Balloon path sleeps 6s; give it headroom.
    timeoutMs: 15000,
  });
}

/** Quote a string as a PowerShell single-quoted string literal. */
function psQuote(s: string): string {
  // In PowerShell single-quotes, the only escape is '' for an embedded quote.
  return `'${s.replace(/'/g, "''")}'`;
}

/** Write an ASCII BEL to stdout so supported terminals flash/ring. */
function ringBell(): void {
  try {
    process.stdout.write("\x07");
  } catch {
    /* stdout unavailable — ignore */
  }
}

// ─── Power management (macOS caffeinate) ─────────────────────────────────────
//
// Mirrors Claude Code's preventSleep.ts: spawn `caffeinate -i -t <secs>` to
// create a power assertion that prevents idle sleep, and restart it before the
// timeout expires. The timeout makes the assertion self-healing — if this
// process is SIGKILL'd, the orphaned caffeinate still auto-exits.
//
// Ref-counted so multiple callers can request sleep prevention and the
// assertion is only released when the last caller is done. No-op off macOS.

const CAFFEINATE_TIMEOUT_SECONDS = 300; // 5 minutes
const RESTART_INTERVAL_MS = 4 * 60 * 1000; // restart before expiry

import type { Subprocess } from "bun";

let caffeinateProcess: Subprocess<"ignore", "ignore", "ignore"> | null = null;
let caffeinatePid: number | null = null;
let restartTimer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;

/**
 * Request that the system not idle-sleep while work is in progress.
 * Ref-counted: call preventSleep() when starting work and allowSleep() when
 * done. No-op on non-macOS platforms or if `caffeinate` is unavailable.
 */
export function preventSleep(): void {
  if (PLATFORM !== "macos") return;

  refCount++;
  if (refCount !== 1) return; // already preventing

  spawnCaffeinate();
  startRestartInterval();
}

/**
 * Release one hold on sleep prevention. The assertion is only dropped once
 * the ref count reaches zero. Safe to call without a matching preventSleep().
 */
export function allowSleep(): void {
  if (PLATFORM !== "macos") return;

  if (refCount > 0) refCount--;
  if (refCount === 0) {
    stopRestartInterval();
    killCaffeinate();
  }
}

/**
 * Force-release sleep prevention regardless of ref count. Intended for
 * process-exit cleanup. No-op on non-macOS.
 */
export function forceAllowSleep(): void {
  if (PLATFORM !== "macos") return;
  refCount = 0;
  stopRestartInterval();
  killCaffeinate();
}

/** Current reference count (mainly for tests / diagnostics). */
export function preventSleepRefCount(): number {
  return refCount;
}

function startRestartInterval(): void {
  if (restartTimer !== null) return;

  restartTimer = setInterval(() => {
    if (refCount > 0) {
      killCaffeinate();
      spawnCaffeinate();
    }
  }, RESTART_INTERVAL_MS);

  // Don't let the timer keep the event loop alive on its own.
  // (Bun's setInterval returns the same Node-style handle.)
  if (
    restartTimer &&
    typeof restartTimer === "object" &&
    "unref" in restartTimer &&
    typeof (restartTimer as { unref: unknown }).unref === "function"
  ) {
    (restartTimer as { unref: () => void }).unref();
  }
}

function stopRestartInterval(): void {
  if (restartTimer !== null) {
    clearInterval(restartTimer);
    restartTimer = null;
  }
}

function spawnCaffeinate(): void {
  if (caffeinateProcess !== null) return;

  try {
    const proc = Bun.spawn({
      cmd: [
        "caffeinate",
        "-i", // prevent idle sleep (display may still sleep)
        "-t",
        String(CAFFEINATE_TIMEOUT_SECONDS),
      ],
      stdout: "ignore",
      stderr: "ignore",
    });

    // Don't let caffeinate keep this process alive.
    try {
      proc.unref?.();
    } catch {
      /* unref not available — ignore */
    }

    caffeinateProcess = proc;
    // Capture the PID so killCaffeinate can target it directly even if the
    // Subprocess object's own kill() races the spawn (Bun.spawn returns before
    // the child is guaranteed live).
    try {
      caffeinatePid = proc.pid ?? null;
    } catch {
      caffeinatePid = null;
    }

    const thisProc = proc;
    void proc.exited.then(() => {
      if (caffeinateProcess === thisProc) {
        caffeinateProcess = null;
        caffeinatePid = null;
      }
    });
  } catch {
    // caffeinate missing or spawn failed — silently degrade.
    caffeinateProcess = null;
    caffeinatePid = null;
  }
}

function killCaffeinate(): void {
  const proc = caffeinateProcess;
  const pid = caffeinatePid;
  caffeinateProcess = null;
  caffeinatePid = null;

  // Prefer the Subprocess handle's kill()...
  if (proc !== null) {
    try {
      // Bun's Subprocess.kill takes a signal NAME (not a numeric code like
      // Node's child_process). SIGKILL = immediate, no graceful-delay window
      // during which sleep could resume.
      proc.kill("SIGKILL");
    } catch {
      /* process may have already exited */
    }
  }

  // ...and also signal by PID as a race-proof fallback. process.kill throws
  // ESRCH if the process is already gone, which we swallow.
  if (pid !== null && pid > 0) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already reaped */
    }
  }
}
