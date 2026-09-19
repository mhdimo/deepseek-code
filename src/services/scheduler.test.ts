/**
 * The scheduler was a clock nobody wound. ScheduleCronTool wrote jobs to
 * ~/.deepseek-code/schedules.json, listed them back, and told the model "it
 * will fire once then auto-delete" — while `startScheduler` had no callers and
 * the 1s tick that fires anything never ran. `setBusy` had no callers either,
 * so even a running scheduler would have fired jobs into the middle of a turn.
 *
 * These tests drive the real timers (at a fast tick, through the real queue)
 * against a sandboxed data dir, because the thing that was broken is the
 * wiring between the clock, the disk and the queue — not the arithmetic.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSystemTime } from "bun:test";
import {
  MAX_AGE_DAYS,
  cancelJob,
  createJob,
  listAllJobs,
  readSchedules,
  setBusy,
  startScheduler,
  stopScheduler,
} from "./scheduler.js";
import { readFileSync as readSourceFile } from "node:fs";

const TICK = 15;

/** A cron that matches every minute — the tick decides when a due job fires,
 *  so the expression only has to be valid and in the past. */
const EVERY_MINUTE = "* * * * *";

let dir: string;
let prevData: string | undefined;
let fired: string[];

function schedulesPath(): string {
  return join(dir, "schedules.json");
}

/** Write a durable job straight to disk, as an earlier session would have. */
function writeDurable(over: {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
  recurring?: boolean;
  lastFiredAt?: number;
}): void {
  const job: Record<string, unknown> = {
    id: over.id,
    cron: over.cron,
    prompt: over.prompt,
    createdAt: over.createdAt,
    ...(over.recurring ? { recurring: true } : {}),
    ...(over.lastFiredAt !== undefined ? { lastFiredAt: over.lastFiredAt } : {}),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(schedulesPath(), JSON.stringify({ tasks: [job] }, null, 2) + "\n");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the scheduler");
    await Bun.sleep(5);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dc-scheduler-"));
  prevData = process.env.DEEPSEEK_CODE_DATA_DIR;
  process.env.DEEPSEEK_CODE_DATA_DIR = dir;
  fired = [];
});

afterEach(() => {
  stopScheduler();
  setBusy(false);
  setSystemTime();
  for (const job of listAllJobs()) cancelJob(job.id);
  if (prevData === undefined) delete process.env.DEEPSEEK_CODE_DATA_DIR;
  else process.env.DEEPSEEK_CODE_DATA_DIR = prevData;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// The clock runs
// ---------------------------------------------------------------------------

describe("startScheduler", () => {
  test("a due job fires, and its prompt is handed to the queue", async () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    writeDurable({
      id: "job-1",
      cron: EVERY_MINUTE,
      prompt: "check the build",
      createdAt: fiveMinutesAgo,
    });

    startScheduler((prompt) => fired.push(prompt), TICK);
    await waitFor(() => fired.length > 0);

    expect(fired).toEqual(["check the build"]);
  });

  test("a one-shot fires once and clears itself off disk", async () => {
    writeDurable({
      id: "job-once",
      cron: EVERY_MINUTE,
      prompt: "remind me",
      createdAt: Date.now() - 5 * 60 * 1000,
    });

    startScheduler((prompt) => fired.push(prompt), TICK);
    await waitFor(() => fired.length > 0);
    // Several more ticks: a one-shot must not come back.
    await Bun.sleep(TICK * 6);

    expect(fired).toEqual(["remind me"]);
    expect(readSchedules()).toEqual([]);
  });

  test("a job that came due while the app was closed still fires", async () => {
    // "survives restarts" has to mean the reminder set for yesterday is not
    // simply lost.
    writeDurable({
      id: "yesterday",
      cron: EVERY_MINUTE,
      prompt: "water the plants",
      createdAt: Date.now() - 20 * 60 * 60 * 1000,
    });

    startScheduler((prompt) => fired.push(prompt), TICK);
    await waitFor(() => fired.length > 0);

    expect(fired).toEqual(["water the plants"]);
  });

  test("a recurring job fires, then waits for its next turn", async () => {
    writeDurable({
      id: "recur",
      cron: EVERY_MINUTE,
      prompt: "poll the deploy",
      createdAt: Date.now() - 5 * 60 * 1000,
      recurring: true,
    });

    startScheduler((prompt) => fired.push(prompt), TICK);
    await waitFor(() => fired.length > 0);
    await Bun.sleep(TICK * 6);

    // Once, not once per tick — and the fire is recorded on disk so the next
    // match is counted from here.
    expect(fired).toEqual(["poll the deploy"]);
    const [job] = readSchedules();
    expect(job?.lastFiredAt).toBeGreaterThan(0);

    // An hour later it fires again.
    const now = Date.now();
    setSystemTime(new Date(now + 60 * 60 * 1000));
    await waitFor(() => fired.length > 1);
    expect(fired.length).toBe(2);
  });

  // Expiry is enforced twice — the reload skips an expired job and the sweep
  // deletes it — so "it did not fire" alone proves neither half. What is
  // observable is that the file it came from is left clean.
  test("a job past its expiry is swept, not fired", async () => {
    const tooOld = Date.now() - (MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000;
    writeDurable({
      id: "stale",
      cron: EVERY_MINUTE,
      prompt: "ancient history",
      createdAt: tooOld,
      recurring: true,
    });

    startScheduler((prompt) => fired.push(prompt), TICK);
    await Bun.sleep(TICK * 6);

    expect(fired).toEqual([]);
    expect(readSchedules()).toEqual([]);
  });

  test("stopScheduler stops the clock", async () => {
    writeDurable({
      id: "later",
      cron: EVERY_MINUTE,
      prompt: "too late",
      createdAt: Date.now() - 5 * 60 * 1000,
    });

    startScheduler((prompt) => fired.push(prompt), TICK);
    stopScheduler();
    await Bun.sleep(TICK * 6);

    expect(fired).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Busy: deferred, never dropped
// ---------------------------------------------------------------------------

describe("setBusy", () => {
  test("a job that comes due mid-turn waits for the turn to end", async () => {
    writeDurable({
      id: "held",
      cron: EVERY_MINUTE,
      prompt: "after the answer",
      createdAt: Date.now() - 5 * 60 * 1000,
    });

    setBusy(true);
    startScheduler((prompt) => fired.push(prompt), TICK);
    await Bun.sleep(TICK * 6);
    expect(fired).toEqual([]);

    setBusy(false);
    await waitFor(() => fired.length > 0);
    expect(fired).toEqual(["after the answer"]);
  });
});

// ---------------------------------------------------------------------------
// Session jobs (the default: durable is false)
// ---------------------------------------------------------------------------

describe("session jobs", () => {
  test("a job created now fires when its minute arrives", async () => {
    const base = new Date("2026-09-19T10:00:30.000Z");
    setSystemTime(base);

    const id = createJob(EVERY_MINUTE, "session prompt", false, false);
    startScheduler((prompt) => fired.push(prompt), TICK);
    await Bun.sleep(TICK * 4);
    expect(fired).toEqual([]);

    setSystemTime(new Date(base.getTime() + 45_000)); // 10:01:15, past the match
    await waitFor(() => fired.length > 0);
    expect(fired).toEqual(["session prompt"]);

    // One-shot session jobs are forgotten too, not left to fire again.
    await Bun.sleep(TICK * 6);
    expect(fired).toEqual(["session prompt"]);
    expect(listAllJobs().find((j) => j.id === id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wiring: the loop owns the clock
// ---------------------------------------------------------------------------

describe("the app winds the clock", () => {
  const app = readSourceFile(join(import.meta.dir, "../components/App.tsx"), "utf-8");

  test("the scheduler is started on mount and stopped on exit", () => {
    expect(app).toContain('from "../services/scheduler.js"');
    const start = app.indexOf("startScheduler((prompt) => {");
    expect(start).toBeGreaterThan(-1);
    // Started with something to enqueue into, and cleaned up after.
    expect(app.slice(start, start + 200)).toContain("setQueuedSubmissions");
    expect(app.indexOf("return () => stopScheduler();")).toBeGreaterThan(start);
  });

  test("a fired job becomes an ordinary queued turn", () => {
    // The queue the scheduler writes to is the one the drain effect reads.
    const enqueue = app.indexOf("setQueuedSubmissions((prev) => [...prev, prompt]);");
    const drain = app.indexOf("void submitUserPrompt(next!);");
    expect(enqueue).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(-1);
    expect(app.slice(drain - 400, drain)).toContain("queuedSubmissions.length === 0");
  });

  test("the agent is marked busy for the duration of a turn", () => {
    const busy = app.indexOf("setBusy(isLoading);");
    expect(busy).toBeGreaterThan(-1);
    // Wired to isLoading, in an effect that reruns when it changes.
    expect(app.slice(busy - 200, busy + 60)).toContain("[isLoading]");
  });
});
