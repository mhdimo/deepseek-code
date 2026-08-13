





















import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import {
  computeNextCronRun,
  parseCronExpression,
} from "../utils/cron.js";



const DATA_DIR = join(homedir(), ".deepseek-code");
const SCHEDULES_FILE = join(DATA_DIR, "schedules.json");


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
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}


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
  writeFileSync(SCHEDULES_FILE, JSON.stringify(body, null, 2) + "\n", "utf-8");
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


export function startScheduler(enqueue: EnqueueFn): void {
  state.enqueue = enqueue;
  state.started = true;
  reloadFromDisk();
  if (state.interval) clearInterval(state.interval);
  state.interval = setInterval(tick, TICK_MS);
  
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
