/**
 * Teardown that has to happen before the process dies.
 *
 * `process.on("exit")` is the one hook every exit path runs — a command, a
 * crash, Ink's unmount — but its handlers are synchronous: anything awaited
 * there is dropped on the floor. Cleanups registered here are therefore
 * synchronous by contract, and should be the *last* signal they send rather
 * than a request they wait on.
 *
 * Signals are handled separately because a process killed by one runs no exit
 * handlers at all: without this, `kill <pid>` (or a terminal closing) leaves
 * the work this process started — background shells, subprocess trees — running
 * with nothing left to supervise it.
 */
export type ExitCleanup = () => void;

const cleanups: ExitCleanup[] = [];
let installed = false;

const SIGNALS: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
];

/** Register a synchronous teardown. Runs on exit, and on a terminating signal. */
export function onExitCleanup(cleanup: ExitCleanup): void {
  cleanups.push(cleanup);
  if (installed) return;
  installed = true;

  process.on("exit", runExitCleanups);
  for (const [signal, code] of SIGNALS) {
    process.on(signal, () => {
      runExitCleanups();
      process.exit(code);
    });
  }
}

/**
 * Run every registered cleanup. Draining the list (rather than a one-shot flag)
 * keeps the exit handler and a signal handler from running the same teardown
 * twice, while leaving room for a cleanup registered afterwards.
 *
 * A throwing cleanup never blocks the others — the process is going away
 * either way, and half the teardown beats none of it.
 */
export function runExitCleanups(): void {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {

    }
  }
}
