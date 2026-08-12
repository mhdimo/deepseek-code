// In-process cron scheduler for scheduled prompts.
//
// Stores jobs in ~/.deepseek-code/schedules.json (the DeepSeek data dir, per
// src/state/storage.ts). Each job enqueues a prompt by invoking an
// application-supplied "enqueue" callback — the integrator wires this in App
// (see sharedFileWiring) to push the prompt onto the same submission path the
// user's typed prompts take.
//
// Design notes:
//   - Single global scheduler instance (singleton). App.startScheduler() on
//     boot; stopScheduler() on exit.
//   - Two job flavors: one-shot (recurring:false -> fire once, auto-delete)
//     and recurring (recurring:true -> reschedule after each fire, auto-expire
//     after MAX_AGE_DAYS).
//   - The tick loop runs on a 1s setInterval, but only fires jobs while the
//     app is "idle" (not mid-query). App reports idle/busy via setBusy().
//   - Deterministic per-task jitter (see jitteredFireMs) avoids a thundering
//     herd when many sessions share a cron string.
//
// This is a TS-only solution — the C++ backend is not involved (the scheduler
// lives entirely on the TUI side, alongside the rest of the tooling state).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import {
  computeNextCronRun,
  parseCronExpression,
} from "../utils/cron.js";

// ─── Paths & constants ───────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), ".deepseek-code");
const SCHEDULES_FILE = join(DATA_DIR, "schedules.json");

/** Hard cap on the number of scheduled jobs. */
export const MAX_JOBS = 50;

/** Recurring jobs auto-expire after this many days. */
export const MAX_AGE_DAYS = 7;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** Tick interval for the scheduler loop. */
const TICK_MS = 1000;

export interface ScheduledJob {
  /** 8-hex-char short id. */
  id: string;
  /** 5-field cron string (local time). */
  cron: string;
  /** Prompt to enqueue when the job fires. */
  prompt: string;
  /** Epoch ms when the job was created. */
  createdAt: number;
  /** Most recent fire time (recurring only); persisted so restarts resume. */
  lastFiredAt?: number;
  /** true = reschedule after fire; false = fire once then auto-delete. */
  recurring?: boolean;
}

type SchedulesFile = { tasks: ScheduledJob[] };

/**
 * The enqueue hook. App supplies this — it pushes the prompt onto the same
 * submission path the user's typed prompts take. Returning void is fine;
 * the scheduler does not wait for the prompt to finish.
 */
export type EnqueueFn = (prompt: string) => void;

// ─── Persistence ─────────────────────────────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/** Read & validate schedules.json. Malformed entries are dropped silently. */
export function readSchedules(): ScheduledJob[] {
  try {
    if (!existsSync(SCHEDULES_FILE)) return [];
    const raw = readFileSync(SCHEDULES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SchedulesFile>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
      return [];
    }
    const out: ScheduledJob[] = [];
    for (const t of parsed.tasks) {
      if (
        !t ||
        typeof t.id !== "string" ||
        typeof t.cron !== "string" ||
        typeof t.prompt !== "string" ||
        typeof t.createdAt !== "number"
      ) {
        continue;
      }
      if (!parseCronExpression(t.cron)) continue; // drop entries with bad cron
      out.push({
        id: t.id,
        cron: t.cron,
        prompt: t.prompt,
        createdAt: t.createdAt,
        ...(typeof t.lastFiredAt === "number" ? { lastFiredAt: t.lastFiredAt } : {}),
        ...(t.recurring ? { recurring: true } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function writeSchedules(tasks: ScheduledJob[]): void {
  ensureDataDir();
  const body: SchedulesFile = { tasks };
  writeFileSync(SCHEDULES_FILE, JSON.stringify(body, null, 2) + "\n", "utf-8");
}

// ─── Cron helpers ────────────────────────────────────────────────────────────

/** Next fire time in epoch ms for a cron string, strictly after `fromMs`. */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const fields = parseCronExpression(cron);
  if (!fields) return null;
  const next = computeNextCronRun(fields, new Date(fromMs));
  return next ? next.getTime() : null;
}

/**
 * taskId is an 8-hex-char UUID slice -> parse as u32 -> [0, 1). Stable across
 * restarts, uniformly distributed. Non-hex ids fall back to 0 = no jitter.
 */
function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000;
  return Number.isFinite(frac) ? frac : 0;
}

const RECURRING_FRAC = 0.1; // forward delay as a fraction of the fire interval
const RECURRING_CAP_MS = 15 * 60 * 1000; // max 15 min forward delay
const ONE_SHOT_MAX_MS = 90 * 1000; // one-shots may fire up to 90s early
const ONE_SHOT_MINUTE_MOD = 30; // jitter :00 and :30 (human-rounding hotspots)

/**
 * Recurring fire time with deterministic forward jitter to spread a fleet
 * that shares the same cron string across [:next, :next + cap].
 */
function jitteredRecurringMs(
  cron: string,
  fromMs: number,
  taskId: string,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs);
  if (t1 === null) return null;
  const t2 = nextCronRunMs(cron, t1);
  if (t2 === null) return t1; // pinned date, nothing to proportion against
  const jitter = Math.min(
    jitterFrac(taskId) * RECURRING_FRAC * (t2 - t1),
    RECURRING_CAP_MS,
  );
  return t1 + jitter;
}

/**
 * One-shot fire time with deterministic backward lead when the fire lands on
 * a minute boundary (:00/:30). One-shots are user-pinned, so we never delay —
 * only fire slightly early, which is invisible and spreads the inference spike.
 */
function jitteredOneShotMs(cron: string, fromMs: number, taskId: string): number | null {
  const t1 = nextCronRunMs(cron, fromMs);
  if (t1 === null) return null;
  // Cron resolution is 1 minute -> computed times have :00 seconds.
  if (new Date(t1).getMinutes() % ONE_SHOT_MINUTE_MOD !== 0) return t1;
  const lead = jitterFrac(taskId) * ONE_SHOT_MAX_MS;
  // t1 > fromMs is guaranteed (strictly after); max() bites only if the task
  // was created inside its own lead window.
  return Math.max(t1 - lead, fromMs);
}

/**
 * Compute the next fire time (epoch ms) for a job, anchored from `anchorMs`.
 * For recurring jobs that have fired before, anchor from `lastFiredAt`.
 */
function computeFireMs(job: ScheduledJob, anchorMs: number): number | null {
  return job.recurring
    ? jitteredRecurringMs(job.cron, anchorMs, job.id)
    : jitteredOneShotMs(job.cron, anchorMs, job.id);
}

// ─── Scheduler singleton ─────────────────────────────────────────────────────

interface SchedulerState {
  enqueue: EnqueueFn | null;
  /** True when the REPL is idle (not mid-query). Jobs only fire when idle. */
  busy: boolean;
  /** Map of jobId -> computed next fire time (epoch ms). */
  nextFire: Map<string, number>;
  interval: ReturnType<typeof setInterval> | null;
  started: boolean;
}

const state: SchedulerState = {
  enqueue: null,
  busy: false,
  nextFire: new Map(),
  interval: null,
  started: false,
};

/**
 * Start the scheduler. Loads durable jobs from disk, computes their next fire
 * times, and begins ticking. Safe to call multiple times — re-starting reloads
 * from disk. The enqueue callback is how fired prompts reach the App.
 */
export function startScheduler(enqueue: EnqueueFn): void {
  state.enqueue = enqueue;
  state.started = true;
  reloadFromDisk();
  if (state.interval) clearInterval(state.interval);
  state.interval = setInterval(tick, TICK_MS);
  // Don't keep the process alive solely for the scheduler — the TUI keeps it up.
  if (typeof (state.interval as any)?.unref === "function") {
    (state.interval as any).unref();
  }
}

/** Stop the tick loop (e.g. on app exit). */
export function stopScheduler(): void {
  state.started = false;
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
}

/** App reports whether a query is currently running. Jobs only fire when idle. */
export function setBusy(busy: boolean): void {
  state.busy = busy;
}

/**
 * Reload durable jobs from disk into the nextFire map. Called on start and
 * whenever a durable job is created/deleted/updated. Session-only jobs are
 * also tracked here via addSessionJob/removeSessionJob.
 */
function reloadFromDisk(): void {
  const jobs = readSchedules();
  const now = Date.now();
  state.nextFire.clear();
  // Re-seed any in-memory session jobs (kept separately, not on disk).
  for (const [id, fireMs] of sessionJobs) {
    state.nextFire.set(id, fireMs);
  }
  for (const job of jobs) {
    if (jobExpired(job, now)) continue; // expired entries are swept on persist
    const anchor = job.lastFiredAt ?? job.createdAt;
    const fire = computeFireMs(job, anchor);
    if (fire !== null) state.nextFire.set(job.id, fire);
  }
  sweepExpiredOnDisk(now);
}

function jobExpired(job: ScheduledJob, nowMs: number): boolean {
  if (!job.recurring) return false; // one-shots die by firing, not age
  return nowMs - job.createdAt >= MAX_AGE_MS;
}

/** Remove expired recurring jobs from the on-disk file. */
function sweepExpiredOnDisk(nowMs: number): void {
  const jobs = readSchedules();
  const remaining = jobs.filter((j) => !jobExpired(j, nowMs));
  if (remaining.length !== jobs.length) writeSchedules(remaining);
}

// ─── Session-only (in-memory) jobs ───────────────────────────────────────────

/**
 * In-memory store for session-only jobs (durable:false). Keyed by id ->
 * computed next fire time. Lives only for this process.
 */
const sessionJobs = new Map<string, number>();
const sessionJobMeta = new Map<string, ScheduledJob>();

function addSessionJob(job: ScheduledJob): void {
  const now = Date.now();
  const fire = computeFireMs(job, job.lastFiredAt ?? job.createdAt);
  if (fire === null) return;
  sessionJobMeta.set(job.id, job);
  sessionJobs.set(job.id, fire);
  state.nextFire.set(job.id, fire);
  void now;
}

function removeSessionJob(id: string): boolean {
  const had = sessionJobs.delete(id);
  sessionJobMeta.delete(id);
  state.nextFire.delete(id);
  return had;
}

function getDurableJob(id: string): ScheduledJob | undefined {
  return readSchedules().find((j) => j.id === id);
}

// ─── Public job API (used by the tool) ───────────────────────────────────────

/** Create a job. Returns the generated id. Throws on invalid cron / over cap. */
export function createJob(
  cron: string,
  prompt: string,
  recurring: boolean,
  durable: boolean,
): string {
  const fields = parseCronExpression(cron);
  if (!fields) {
    throw new Error(
      `Invalid cron expression '${cron}'. Expected 5 fields: M H DoM Mon DoW.`,
    );
  }
  if (nextCronRunMs(cron, Date.now()) === null) {
    throw new Error(
      `Cron expression '${cron}' does not match any calendar date in the next year.`,
    );
  }

  const all = listAllJobs();
  if (all.length >= MAX_JOBS) {
    throw new Error(`Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`);
  }

  const id = randomUUID().slice(0, 8);
  const job: ScheduledJob = {
    id,
    cron,
    prompt,
    createdAt: Date.now(),
    ...(recurring ? { recurring: true } : {}),
  };

  if (durable) {
    const tasks = readSchedules();
    tasks.push(job);
    writeSchedules(tasks);
  } else {
    addSessionJob(job);
  }

  // Seed the live fire map immediately (no need to wait for the next tick).
  if (state.started) {
    const fire = computeFireMs(job, job.createdAt);
    if (fire !== null) state.nextFire.set(job.id, fire);
  }

  return id;
}

/** Cancel a job by id (durable or session-only). Returns true if removed. */
export function cancelJob(id: string): boolean {
  // Session store first.
  if (removeSessionJob(id)) return true;
  // Then durable file.
  const tasks = readSchedules();
  const remaining = tasks.filter((t) => t.id !== id);
  if (remaining.length === tasks.length) return false;
  writeSchedules(remaining);
  state.nextFire.delete(id);
  return true;
}

export interface ListJobView {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  createdAt: number;
}

/** List all jobs (durable + session-only). */
export function listAllJobs(): ListJobView[] {
  const durable = readSchedules().map((j) => ({
    id: j.id,
    cron: j.cron,
    prompt: j.prompt,
    recurring: !!j.recurring,
    durable: true,
    createdAt: j.createdAt,
  }));
  const session = Array.from(sessionJobMeta.values()).map((j) => ({
    id: j.id,
    cron: j.cron,
    prompt: j.prompt,
    recurring: !!j.recurring,
    durable: false,
    createdAt: j.createdAt,
  }));
  return [...durable, ...session];
}

// ─── Tick loop ───────────────────────────────────────────────────────────────

function tick(): void {
  if (!state.started) return;
  if (!state.enqueue) return;

  // Jobs only fire while the REPL is idle (not mid-query). Pending fires will
  // be picked up on the next idle tick (see the missed-fire handling below).
  if (state.busy) return;

  const now = Date.now();
  const durableTasks = readSchedules();
  const durableById = new Map(durableTasks.map((t) => [t.id, t]));
  const firedRecurring: Array<{ id: string; firedAt: number }> = [];
  const firedOneShotIds: string[] = [];

  for (const [id, fireMs] of state.nextFire) {
    if (fireMs > now) continue;

    const durable = durableById.get(id);
    const session = sessionJobMeta.get(id);
    const job = durable ?? session;
    if (!job) {
      // Stale entry (deleted between ticks) — drop it.
      state.nextFire.delete(id);
      continue;
    }

    // Enqueue the prompt.
    try {
      state.enqueue(job.prompt);
    } catch {
      // Enqueue failures shouldn't crash the scheduler.
    }

    if (job.recurring) {
      firedRecurring.push({ id, firedAt: now });
    } else {
      firedOneShotIds.push(id);
    }
  }

  // Reschedule recurring + sweep one-shots.
  for (const { id, firedAt } of firedRecurring) {
    const durable = durableById.get(id);
    const session = sessionJobMeta.get(id);
    const job = durable ?? session;
    if (job) {
      const nextFire = computeFireMs({ ...job, lastFiredAt: firedAt }, firedAt);
      if (nextFire !== null) {
        state.nextFire.set(id, nextFire);
      } else {
        state.nextFire.delete(id);
      }
    }
    if (durable) {
      // Persist lastFiredAt so restarts resume correctly.
      const tasks = readSchedules();
      for (const t of tasks) {
        if (t.id === id) t.lastFiredAt = firedAt;
      }
      writeSchedules(tasks);
    }
  }

  for (const id of firedOneShotIds) {
    state.nextFire.delete(id);
    // Remove from whichever store owns it.
    if (!removeSessionJob(id)) {
      const tasks = readSchedules();
      const remaining = tasks.filter((t) => t.id !== id);
      if (remaining.length !== tasks.length) writeSchedules(remaining);
    }
  }

  // Sweep expired recurring jobs.
  sweepExpiredOnDisk(now);
}
