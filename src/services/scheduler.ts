





















import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  computeNextCronRun,
  parseCronExpression,
} from "../utils/cron.js";
import { dataDir } from "../utils/dataDir.js";



/** Resolved per call, like every other store — see utils/dataDir.ts. A
 *  module-level path would be pinned by import order, which put the schedules
 *  file in the real home directory even when the app was pointed elsewhere. */
function schedulesFile(): string {
  return join(dataDir(), "schedules.json");
}


export const MAX_JOBS = 50;


export const MAX_AGE_DAYS = 7;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;


const TICK_MS = 1000;

export interface ScheduledJob {
  
  id: string;
  
  cron: string;
  
  prompt: string;
  
  createdAt: number;
  
  lastFiredAt?: number;
  
  recurring?: boolean;
}

type SchedulesFile = { tasks: ScheduledJob[] };


export type EnqueueFn = (prompt: string) => void;



function ensureDataDir(): void {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}


export function readSchedules(): ScheduledJob[] {
  try {
    if (!existsSync(schedulesFile())) return [];
    const raw = readFileSync(schedulesFile(), "utf-8");
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
      if (!parseCronExpression(t.cron)) continue; 
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
  writeFileSync(schedulesFile(), JSON.stringify(body, null, 2) + "\n", "utf-8");
}




export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const fields = parseCronExpression(cron);
  if (!fields) return null;
  const next = computeNextCronRun(fields, new Date(fromMs));
  return next ? next.getTime() : null;
}


function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000;
  return Number.isFinite(frac) ? frac : 0;
}

const RECURRING_FRAC = 0.1; 
const RECURRING_CAP_MS = 15 * 60 * 1000; 
const ONE_SHOT_MAX_MS = 90 * 1000; 
const ONE_SHOT_MINUTE_MOD = 30; 


function jitteredRecurringMs(
  cron: string,
  fromMs: number,
  taskId: string,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs);
  if (t1 === null) return null;
  const t2 = nextCronRunMs(cron, t1);
  if (t2 === null) return t1; 
  const jitter = Math.min(
    jitterFrac(taskId) * RECURRING_FRAC * (t2 - t1),
    RECURRING_CAP_MS,
  );
  return t1 + jitter;
}


function jitteredOneShotMs(cron: string, fromMs: number, taskId: string): number | null {
  const t1 = nextCronRunMs(cron, fromMs);
  if (t1 === null) return null;
  
  if (new Date(t1).getMinutes() % ONE_SHOT_MINUTE_MOD !== 0) return t1;
  const lead = jitterFrac(taskId) * ONE_SHOT_MAX_MS;
  
  
  return Math.max(t1 - lead, fromMs);
}


function computeFireMs(job: ScheduledJob, anchorMs: number): number | null {
  return job.recurring
    ? jitteredRecurringMs(job.cron, anchorMs, job.id)
    : jitteredOneShotMs(job.cron, anchorMs, job.id);
}



interface SchedulerState {
  enqueue: EnqueueFn | null;
  
  busy: boolean;
  
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
 * Begin watching the clock.
 *
 * Nothing called this until now, which is why scheduled jobs never fired: the
 * tool wrote them to disk, the CLI listed them, the prompt said "it will fire
 * once then auto-delete", and the tick that would have done it was never
 * running. The loop's caller owns that: `App` starts it on mount with an
 * enqueue that pushes onto the same queue user submissions use.
 *
 * `enqueue` is called for each job whose time has come, and jobs are deferred
 * — not dropped — while `setBusy(true)` is in effect, so a scheduled prompt
 * arrives as a normal turn taken when the agent is idle.
 *
 * Durable jobs are read back at start, and one whose time passed while the app
 * was closed is already due: it fires on the first tick (a one-shot, then
 * deleting itself; a recurring one, then rescheduling from now). That is what
 * "survives restarts" has to mean — otherwise a reminder set for last night is
 * simply lost.
 *
 * `tickMs` is how often the clock is consulted; the default is the real one.
 *
 * Headless runs (`--print`) deliberately do not start it: there is no loop to
 * hand a fired prompt to, and a scheduler whose enqueue goes nowhere would
 * consume jobs — deleting one-shots, advancing recurring ones past their
 * match — without ever running them. Jobs left on disk fire on the next
 * interactive launch instead.
 */
export function startScheduler(enqueue: EnqueueFn, tickMs: number = TICK_MS): void {
  state.enqueue = enqueue;
  state.started = true;
  reloadFromDisk();
  if (state.interval) clearInterval(state.interval);
  state.interval = setInterval(tick, tickMs);

  if (typeof (state.interval as any)?.unref === "function") {
    (state.interval as any).unref();
  }
}


export function stopScheduler(): void {
  state.started = false;
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
}


/**
 * Whether a turn is in flight. Fired jobs are held while this is set and run
 * on the first tick after it clears, so a schedule cannot land in the middle
 * of the answer it was meant to follow up on. (A job that came due while busy
 * keeps its place in `nextFire` — it is deferred, never skipped.)
 */
export function setBusy(busy: boolean): void {
  state.busy = busy;
}


function reloadFromDisk(): void {
  const jobs = readSchedules();
  const now = Date.now();
  state.nextFire.clear();
  
  for (const [id, fireMs] of sessionJobs) {
    state.nextFire.set(id, fireMs);
  }
  for (const job of jobs) {
    if (jobExpired(job, now)) continue; 
    const anchor = job.lastFiredAt ?? job.createdAt;
    const fire = computeFireMs(job, anchor);
    if (fire !== null) state.nextFire.set(job.id, fire);
  }
  sweepExpiredOnDisk(now);
}

function jobExpired(job: ScheduledJob, nowMs: number): boolean {
  if (!job.recurring) return false; 
  return nowMs - job.createdAt >= MAX_AGE_MS;
}


function sweepExpiredOnDisk(nowMs: number): void {
  const jobs = readSchedules();
  const remaining = jobs.filter((j) => !jobExpired(j, nowMs));
  if (remaining.length !== jobs.length) writeSchedules(remaining);
}




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

  
  if (state.started) {
    const fire = computeFireMs(job, job.createdAt);
    if (fire !== null) state.nextFire.set(job.id, fire);
  }

  return id;
}


export function cancelJob(id: string): boolean {
  
  if (removeSessionJob(id)) return true;
  
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



function tick(): void {
  if (!state.started) return;
  if (!state.enqueue) return;

  
  
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
      
      state.nextFire.delete(id);
      continue;
    }

    
    try {
      state.enqueue(job.prompt);
    } catch {
      
    }

    if (job.recurring) {
      firedRecurring.push({ id, firedAt: now });
    } else {
      firedOneShotIds.push(id);
    }
  }

  
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
      
      const tasks = readSchedules();
      for (const t of tasks) {
        if (t.id === id) t.lastFiredAt = firedAt;
      }
      writeSchedules(tasks);
    }
  }

  for (const id of firedOneShotIds) {
    state.nextFire.delete(id);
    
    if (!removeSessionJob(id)) {
      const tasks = readSchedules();
      const remaining = tasks.filter((t) => t.id !== id);
      if (remaining.length !== tasks.length) writeSchedules(remaining);
    }
  }

  
  sweepExpiredOnDisk(now);
}
