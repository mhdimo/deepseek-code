















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
      
      try {
        await proc.kill();
      } catch {
        
      }
      return false;
    }
    return exit.code === 0;
  } catch {
    
    return false;
  }
}


function shellQuote(s: string): string {
  
  return `'${s.replace(/'/g, `'\\''`)}'`;
}



const DEFAULT_TITLE = "DeepSeek Code";

export interface NotifyOptions {
  
  body: string;
  
  title?: string;
  
  bell?: boolean;
}


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

  
  
  if (!delivered && !opts.bell) {
    ringBell();
  }
  return delivered;
}

async function notifyMacOS(title: string, body: string): Promise<boolean> {
  
  
  const script =
    `display notification ${shellQuote(body)} ` +
    `with title ${shellQuote(title)}`;
  return runOk(["osascript", "-e", script]);
}

async function notifyLinux(title: string, body: string): Promise<boolean> {
  
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
    
    timeoutMs: 15000,
  });
}


function psQuote(s: string): string {
  
  return `'${s.replace(/'/g, "''")}'`;
}


function ringBell(): void {
  try {
    process.stdout.write("\x07");
  } catch {
    
  }
}











const CAFFEINATE_TIMEOUT_SECONDS = 300; 
const RESTART_INTERVAL_MS = 4 * 60 * 1000; 

import type { Subprocess } from "bun";

let caffeinateProcess: Subprocess<"ignore", "ignore", "ignore"> | null = null;
let caffeinatePid: number | null = null;
let restartTimer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;


export function preventSleep(): void {
  if (PLATFORM !== "macos") return;

  refCount++;
  if (refCount !== 1) return; 

  spawnCaffeinate();
  startRestartInterval();
}


export function allowSleep(): void {
  if (PLATFORM !== "macos") return;

  if (refCount > 0) refCount--;
  if (refCount === 0) {
    stopRestartInterval();
    killCaffeinate();
  }
}


export function forceAllowSleep(): void {
  if (PLATFORM !== "macos") return;
  refCount = 0;
  stopRestartInterval();
  killCaffeinate();
}


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
        "-i", 
        "-t",
        String(CAFFEINATE_TIMEOUT_SECONDS),
      ],
      stdout: "ignore",
      stderr: "ignore",
    });

    
    try {
      proc.unref?.();
    } catch {
      
    }

    caffeinateProcess = proc;
    
    
    
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
    
    caffeinateProcess = null;
    caffeinatePid = null;
  }
}

function killCaffeinate(): void {
  const proc = caffeinateProcess;
  const pid = caffeinatePid;
  caffeinateProcess = null;
  caffeinatePid = null;

  
  if (proc !== null) {
    try {
      
      
      
      proc.kill("SIGKILL");
    } catch {
      
    }
  }

  
  
  if (pid !== null && pid > 0) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      
    }
  }
}
