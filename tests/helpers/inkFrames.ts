/**
 * Waiting on ink without racing it.
 *
 * The frame assertions in this suite read back everything ink has written to a
 * fake stdout, and a good many of them drive the component by writing keys to
 * a fake stdin first. The obvious way to wait — sleep for a plausible number
 * of milliseconds — is a bet that the renderer got round to it in time. It
 * holds on an idle machine and loses on a busy one, and it loses *quietly*:
 * the frame simply lacks the row the assertion is looking for, so the failure
 * reads as a rendering bug rather than as a slow machine. This suite has
 * already had two files fail on preset runs and pass in isolation that way.
 *
 * Polling for the renderer to go quiet costs nothing when it is already done
 * (one poll interval, versus the sleep it replaces) and cannot lose the race.
 */

/**
 * Resolve once `read()` has stopped changing, or once `timeoutMs` is up.
 *
 * The timeout is a backstop, not a budget: a component that renders nothing
 * more than the frame it already drew returns after roughly `quietMs`. Hitting
 * it means the renderer never settled, and the assertion that follows will
 * fail on whatever frame was last written — which is what you want to see.
 */
export async function settleFrames(
  read: () => string,
  { quietMs = 40, timeoutMs = 2000, intervalMs = 10 }: SettleOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const now = read();
    if (now !== last) {
      last = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return;
    }
  }
}

export interface SettleOptions {
  /** How long the output must be unchanged before it counts as settled. */
  quietMs?: number;
  /** Give up after this long and let the caller's assertion report the frame. */
  timeoutMs?: number;
  intervalMs?: number;
}

/** A `settle` bound to one output buffer — `await settle()` in the helpers
 *  that own their own fake stdout. */
export function settleFor(read: () => string, options?: SettleOptions): () => Promise<void> {
  return () => settleFrames(read, options);
}
