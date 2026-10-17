/**
 * Shell mode (`!command`) — the user's own shell line, run directly instead
 * of being sent to the model.
 *
 * This is deliberately separate from BashTool: BashTool is the model's tool,
 * with its permission gate and its stdout/stderr ordering; shell mode is the
 * user typing in their terminal. The command runs and streams into the
 * transcript, then the model responds to it automatically
 * (`respondToBashCommands`, on by default — Claude Code v2.1.186's behavior).
 * With responses off it is recorded for the next prompt instead. Either way
 * the context is the same shape Claude Code uses (`<bash-input>` /
 * `<bash-stdout>` / `<bash-stderr>` user turns). The `!` itself is never part
 * of the command — it is the mode, held separately by the prompt.
 */
import { spawn } from "node:child_process";

/** Inline cap, matching BashTool's — beyond it the transcript says so. */
export const MAX_SHELL_OUTPUT_BYTES = 50_000;

export interface ShellRunResult {
  command: string;
  /** Arrival-ordered stdout+stderr, ANSI stripped, CRLF normalised. */
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
  /** Set when the process could not be spawned at all. */
  error?: string;
  durationMs: number;
}

export interface ShellRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Live, already-normalised output. Only called with text that was kept
   *  (callers never need to trim the transcript themselves). */
  onOutput?: (chunk: string) => void;
}

// CSI/OSC/ESC sequences. Ink renders text, not terminal state, so ANSI colour
// has to go or it would corrupt wrapping and the mouse selection model.
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function normalise(chunk: string): string {
  return stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function appendCapped(buffer: string, chunk: string): { next: string; dropped: boolean } {
  const room = MAX_SHELL_OUTPUT_BYTES - buffer.length;
  if (chunk.length <= room) return { next: buffer + chunk, dropped: false };
  return { next: buffer + chunk.slice(0, Math.max(0, room)), dropped: true };
}

/**
 * Run `sh -c command` and stream it. Detached with its own process group so
 * Esc can kill the whole tree (`sh -c "npm test"` otherwise outlives the
 * shell). No timeout: the user typed this, and Esc is the way out.
 */
export function runShellCommand(command: string, options: ShellRunOptions): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let output = "";
    let truncated = false;
    let cancelled = false;
    let error: string | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn("sh", ["-c", command], {
      cwd: options.cwd,
      // A shell command's colour is a terminal affordance; the transcript is
      // not a terminal, and the escape codes would break its width math.
      env: { ...process.env, FORCE_COLOR: "0" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", abortHandler);
      resolve({
        command,
        output,
        stdout,
        stderr,
        exitCode,
        cancelled,
        truncated,
        error,
        durationMs: Date.now() - started,
      });
    };

    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };

    const abortHandler = () => {
      if (cancelled || settled) return;
      cancelled = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 250);
      // A process that ignores both signals must not leave the caller's
      // promise pending forever; the transcript can still say "cancelled".
      forceTimer = setTimeout(() => finish(null), 1_500);
    };

    if (options.signal) {
      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    const receive = (raw: Buffer | string, stream: "stdout" | "stderr") => {
      const chunk = normalise(raw.toString());
      if (!chunk) return;

      const stdoutPart = stream === "stdout" ? appendCapped(stdout, chunk) : null;
      if (stdoutPart) {
        stdout = stdoutPart.next;
        truncated ||= stdoutPart.dropped;
      }
      const stderrPart = stream === "stderr" ? appendCapped(stderr, chunk) : null;
      if (stderrPart) {
        stderr = stderrPart.next;
        truncated ||= stderrPart.dropped;
      }
      const before = output.length;
      const combined = appendCapped(output, chunk);
      output = combined.next;
      truncated ||= combined.dropped;

      // Only report what the transcript will keep, so its accumulator and
      // the final record agree.
      const kept = output.slice(before);
      if (kept) options.onOutput?.(kept);
    };

    child.stdout?.on("data", (data: Buffer) => receive(data, "stdout"));
    child.stderr?.on("data", (data: Buffer) => receive(data, "stderr"));

    child.on("close", (code: number | null) => finish(code));
    child.on("error", (err: Error) => {
      error = err.message;
      finish(null);
    });
  });
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The user-turn text a completed command contributes to the model's history.
 * Same tags as Claude Code's bash mode; stderr is XML-escaped because that
 * is where stray `<` characters actually show up.
 */
export function formatShellContext(
  command: string,
  result: Pick<ShellRunResult, "stdout" | "stderr" | "exitCode" | "cancelled" | "truncated">,
): string {
  const parts: string[] = [`<bash-input>${command}</bash-input>`];
  if (result.stdout) parts.push(`<bash-stdout>${result.stdout}</bash-stdout>`);
  if (result.stderr) parts.push(`<bash-stderr>${escapeXml(result.stderr)}</bash-stderr>`);
  if (result.cancelled) parts.push("(command cancelled)");
  else if (result.exitCode !== null && result.exitCode !== 0) parts.push(`(exit ${result.exitCode})`);
  if (result.truncated) {
    parts.push(`(output truncated at ${MAX_SHELL_OUTPUT_BYTES / 1000}KB)`);
  }
  return parts.join("\n");
}

/**
 * The internal turn that answers a finished `!command` — Claude Code's
 * `respondToBashCommands` behavior (settings.json, on by default; v2.1.186).
 * The formatted run is the same user-turn text a later prompt would have
 * carried, so nothing is said twice: this turn *is* that delivery.
 */
export function buildBashResponsePrompt(
  command: string,
  result: Pick<ShellRunResult, "stdout" | "stderr" | "exitCode" | "cancelled" | "truncated">,
): string {
  return [
    "The user ran this command in the terminal's bash mode (`!`). Briefly explain the result: what happened, anything notable in the output (errors, warnings, unexpected values), and what to do next only if something failed. A few sentences, no preamble. Use tools only if the output alone cannot be explained.",
    "",
    formatShellContext(command, result),
  ].join("\n");
}

/**
 * Whether a finished run earns an automatic response. `enabled` mirrors
 * settings.respondToBashCommands (absent means on); a cancelled run never
 * does — Esc is the user saying they are done with it, and a model turn
 * would be a cost they just declined.
 */
export function shouldRespondToBashCommand(
  enabled: boolean,
  result: Pick<ShellRunResult, "cancelled">,
): boolean {
  return enabled && !result.cancelled;
}
