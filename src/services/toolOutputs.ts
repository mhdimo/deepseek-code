import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, type WriteStream } from "fs";
import { dirname, join } from "path";
import { dataDir } from "../utils/dataDir.js";

/**
 * The store for command output too large to hand back inline.
 *
 * It used to be killed instead: stdout crossing the inline cap SIGTERM'd the
 * process group (SIGKILL after 1.5s), so a chatty but perfectly valid command
 * — a test suite, a build, `cat` of a large file — died mid-run and the tool
 * reported only "(output truncated at 50KB)", which reads as a completed run.
 * Side effects were half-applied and the model reasoned from a false premise.
 * The reference never kills on size; it persists the overflow and lets the
 * process finish. So does this: the head stays inline, the whole stream goes
 * to a file the model can Read.
 */

/** Hard ceiling per stream. Bounds a runaway producer's disk, not its runtime. */
const MAX_SPILL_BYTES = 64 * 1024 * 1024;

export interface Spill {
  path: string;
  stream: WriteStream;
  /** Bytes written so far, including the seed. */
  bytes: number;
  /** True once writes stopped — the ceiling was hit, or the file broke. */
  capped: boolean;
}

export function toolOutputsDir(): string {
  return join(dataDir(), "tool-outputs");
}

export function spillPath(id: string, which: "stdout" | "stderr"): string {
  return join(toolOutputsDir(), `${id}-${which}.txt`);
}

/**
 * Start a spill file holding `seed` (the output captured before the stream
 * overflowed) and hand back a handle for the rest of it.
 */
export function openSpill(path: string, seed: string): Spill {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Reported by the write failing below, which keeps the inline head.
  }
  const spill: Spill = { path, stream: createWriteStream(path), bytes: 0, capped: false };
  // A spill file that cannot be written (full disk, bad path) must not take
  // the command down with it — the inline head is still returned.
  spill.stream.on("error", () => {
    spill.capped = true;
  });
  writeSpill(spill, seed);
  return spill;
}

/**
 * Append to a spill file, or drop the chunk once it is at its ceiling.
 * Synchronous on purpose: the stream buffers in memory, so nothing written
 * here can still be lost when the tool result is returned.
 */
export function writeSpill(spill: Spill, chunk: string): boolean {
  // Reached when output arrives after the tool settled (the process group is
  // killed but its pipes drain afterwards): the file is finished, so this is
  // a no-op rather than a write-after-end error on a closed stream.
  if (spill.capped || spill.stream.writableEnded) return false;
  const size = Buffer.byteLength(chunk, "utf8");
  if (spill.bytes + size > MAX_SPILL_BYTES) {
    spill.capped = true;
    return false;
  }
  spill.bytes += size;
  spill.stream.write(chunk);
  return true;
}

/**
 * Finish writing. Awaited before the tool result is returned, so a path the
 * result advertises is complete by the time the model can read it.
 */
export function closeSpill(spill: Spill | null): Promise<void> {
  const stream = spill?.stream;
  if (!stream || stream.destroyed || stream.writableEnded) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    stream.once("close", done);
    stream.once("error", done);
    // A stream that never closes must not wedge the tool result for good.
    timer = setTimeout(done, 2000);
  });
}

/** Points the model at the saved output, and says if even that was cut short. */
export function spillNote(spill: Spill): string {
  const mb = Math.round(MAX_SPILL_BYTES / (1024 * 1024));
  return spill.capped
    ? `full output in ${spill.path}, dropped past ${mb}MB`
    : `full output in ${spill.path}`;
}

/**
 * Delete spill files older than `days`. Called at startup beside the session
 * prune, and for the same reason: the store is a cache, and nothing else ever
 * reclaims it — every deliberate >50KB command would otherwise leave a file
 * here for good. Returns how many were removed, for /doctor-style reporting.
 */
export function pruneOldToolOutputs(days: number): number {
  // Same guard as pruneOldSessions, for the same reason: a threshold of 0 is
  // a cutoff of *now*, so it would sweep the whole cache instead of expiring
  // anything. Spilled output is the model's only copy of a long command's
  // output, so "delete all of it by accident" is not a recoverable mistake.
  if (!Number.isFinite(days) || days <= 0) return 0;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(toolOutputsDir());
  } catch {
    return 0; // nothing spilled yet
  }
  for (const name of names) {
    const path = join(toolOutputsDir(), name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removed++;
      }
    } catch {
      // Raced with another cleanup, or unreadable: leave it for the next run.
    }
  }
  return removed;
}
