











import { z } from "zod";
import { buildTool } from "../../Tool.js";
import { SCHEDULE_CRON_TOOL_NAME, DESCRIPTION } from "./prompt.js";
import {
  cancelJob,
  createJob,
  listAllJobs,
  nextCronRunMs,
  MAX_AGE_DAYS,
} from "../../services/scheduler.js";
import { cronToHuman, parseCronExpression } from "../../utils/cron.js";



const inputSchema = z.object({
  action: z
    .enum(["create", "cancel", "list"])
    .describe("What to do: create a job, cancel one by id, or list all jobs."),
  cron: z
    .string()
    .optional()
    .describe(
      'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once). Required for action: create.',
    ),
  prompt: z
    .string()
    .optional()
    .describe("The prompt to enqueue at each fire time. Required for action: create."),
  recurring: z
    .boolean()
    .optional()
    .describe(
      `true (default) = fire on every cron match until deleted or auto-expired after ${MAX_AGE_DAYS} days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.`,
    ),
  durable: z
    .boolean()
    .optional()
    .describe(
      "true = persist to ~/.deepseek-code/schedules.json and survive restarts. false (default) = in-memory only, dies when this DeepSeek Code session ends. Use true only when the user asks the task to survive across sessions.",
    ),
  id: z
    .string()
    .optional()
    .describe("Job ID returned by action: create. Required for action: cancel."),
});



export const ScheduleCronTool = buildTool({
  name: SCHEDULE_CRON_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,

  userFacingName: (input) => {
    switch (input.action) {
      case "create":
        return `Schedule ${cronToHuman((input.cron as string) ?? "* * * * *")}`;
      case "cancel":
        return `Cancel ${input.id ?? "job"}`;
      case "list":
        return "List scheduled jobs";
      default:
        return "Schedule";
    }
  },

  isEnabled: () => true,
  isReadOnly: (input) => input.action === "list",
  
  isConcurrencySafe: (input) => input.action === "list",

  maxResultSizeChars: 100_000,

  checkPermissions: async (input, context) => {
    
    if (input.action === "list") return { approved: true };

    if (!context.permissions.allowWrite) {
      return { approved: false, feedback: "Write permission denied for this agent." };
    }

    if (input.action === "create") {
      const cron = input.cron ?? "";
      const prompt = input.prompt ?? "";
      const summary = [
        `Schedule cron job`,
        `Cron: ${cron}`,
        `Recurring: ${input.recurring !== false ? "true" : "false"}`,
        `Durable: ${input.durable ? "true" : "false (session-only)"}`,
        `Prompt: ${prompt.length > 200 ? prompt.slice(0, 199) + "…" : prompt}`,
      ].join("\n");
      return context.requestPermission("ScheduleCron", summary);
    }

    
    return context.requestPermission("ScheduleCron", `Cancel scheduled job ${input.id ?? ""}`);
  },

  call: async (input) => {
    const { action } = input;

    if (action === "list") {
      const jobs = listAllJobs();
      if (jobs.length === 0) {
        return { data: "No scheduled jobs." };
      }
      const lines = jobs.map((j) => {
        const human = cronToHuman(j.cron);
        const kind = j.recurring ? "recurring" : "one-shot";
        const dur = j.durable ? "durable" : "session-only";
        const truncated =
          j.prompt.length > 80 ? j.prompt.slice(0, 79) + "…" : j.prompt;
        return `${j.id} — ${human} (${kind}, ${dur}): ${truncated}`;
      });
      return { data: `Scheduled jobs (${jobs.length}):\n${lines.join("\n")}` };
    }

    if (action === "cancel") {
      const id = input.id;
      if (!id) {
        return { data: "Error: id is required for action: cancel." };
      }
      const removed = cancelJob(id);
      return {
        data: removed
          ? `Cancelled job ${id}.`
          : `No scheduled job with id '${id}'.`,
      };
    }

    
    const cron = input.cron;
    const prompt = input.prompt;
    if (!cron) {
      return { data: "Error: cron is required for action: create." };
    }
    if (!prompt) {
      return { data: "Error: prompt is required for action: create." };
    }

    
    if (!parseCronExpression(cron)) {
      return {
        data: `Invalid cron expression '${cron}'. Expected 5 fields: M H DoM Mon DoW.`,
      };
    }
    if (nextCronRunMs(cron, Date.now()) === null) {
      return {
        data: `Cron expression '${cron}' does not match any calendar date in the next year.`,
      };
    }

    const recurring = input.recurring !== false; 
    const durable = !!input.durable;

    let id: string;
    try {
      id = createJob(cron, prompt, recurring, durable);
    } catch (error) {
      return { data: `Error scheduling job: ${(error as Error).message}` };
    }

    const human = cronToHuman(cron);
    const where = durable
      ? "Persisted to ~/.deepseek-code/schedules.json"
      : "Session-only (not written to disk, dies when DeepSeek Code exits)";
    if (recurring) {
      return {
        data: `Scheduled recurring job ${id} (${human}). ${where}. Auto-expires after ${MAX_AGE_DAYS} days. Use action: cancel with this id to stop it sooner.`,
      };
    }
    return {
      data: `Scheduled one-shot task ${id} (${human}). ${where}. It will fire once then auto-delete.`,
    };
  },
});
