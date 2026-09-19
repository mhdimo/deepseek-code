/**
 * A background task is a promise the model makes to its future self: "this
 * keeps running, you'll hear when it stops." The registry kept its own books
 * and the UI got a line, but nothing ever reached the model — so a failed
 * `npm test` in the background stayed invisible until someone asked, and
 * TaskOutput's description promised a notification that did not exist.
 *
 * These tests pin the three links in that chain: the queue (one notification
 * per task, drained once), the registry (every terminal transition enqueues,
 * including the ones nobody remembered), and the delivery (an extra user turn
 * the engine actually sends to the provider — verified against a real
 * OpenAI-compatible endpoint rather than a mock of our own plumbing).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync as readSourceFile, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatTaskNotification,
  formatTaskNotifications,
  notificationFor,
  oneLine,
  pendingTaskNotificationCount,
  pushTaskNotification,
  resetTaskNotifications,
  summarizeTask,
  takeTaskNotifications,
  type TaskNotification,
} from "./notifications.js";
import {
  getTask,
  killTask,
  registerTask,
} from "./backgroundFramework.js";
import type { TaskState } from "../../Task.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function state(over: Partial<TaskState> = {}): TaskState {
  return {
    id: "b1234567",
    type: "shell",
    status: "done",
    command: "bun test",
    outputPath: "/tmp/task-outputs/b1234567.log",
    pid: 4242,
    startedAt: 1000,
    endedAt: 2000,
    exitCode: 0,
    ...over,
  } as TaskState;
}

function notification(over: Partial<TaskNotification> = {}): TaskNotification {
  return {
    taskId: "b1234567",
    type: "shell",
    status: "completed",
    summary: 'Background command "bun test" completed',
    outputPath: "/tmp/task-outputs/b1234567.log",
    ...over,
  };
}

beforeEach(() => {
  resetTaskNotifications();
});

// ---------------------------------------------------------------------------
// Unit: the text the model reads
// ---------------------------------------------------------------------------

describe("oneLine", () => {
  test("collapses newlines so a summary cannot break the block", () => {
    expect(oneLine("a\nb\t c")).toBe("a b c");
  });

  test("bounds the length with a visible ellipsis", () => {
    const out = oneLine("x".repeat(500), 20);
    expect(out.length).toBe(20);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("summarizeTask", () => {
  test("a shell task says what ran and how it ended", () => {
    expect(summarizeTask(state(), "completed")).toBe(
      'Background command "bun test" completed',
    );
    expect(summarizeTask(state({ status: "error", exitCode: 3, error: "Process exited with code 3." }), "failed")).toContain(
      "Process exited with code 3.",
    );
    expect(summarizeTask(state({ status: "error" }), "stopped")).toBe(
      'Background command "bun test" was stopped',
    );
  });

  test("an agent task is named by its description, not its command line", () => {
    const agentState = state({
      type: "agent",
      command: "agent code: review the parser",
      name: "code",
      description: "review the parser",
    });
    expect(summarizeTask(agentState, "completed")).toBe(
      'Agent "review the parser" completed',
    );
    expect(summarizeTask({ ...agentState, error: "boom" } as TaskState, "failed")).toBe(
      'Agent "review the parser" failed: boom',
    );
    expect(summarizeTask(agentState, "stopped")).toBe(
      'Agent "review the parser" was stopped',
    );
  });

  test("workflows read as workflows", () => {
    const wf = state({
      type: "workflow",
      command: "workflow: audit",
      description: "audit the repo",
    });
    expect(summarizeTask(wf, "completed")).toBe('Workflow "audit the repo" completed');
  });
});

describe("notificationFor", () => {
  test("a running task has nothing to report", () => {
    expect(notificationFor(state({ status: "running" } as Partial<TaskState>))).toBeNull();
  });

  test("the status comes from the task, and the kill path can override it", () => {
    const done = notificationFor(state())!;
    expect(done.status).toBe("completed");
    expect(done.summary).toContain("completed");

    const crashed = notificationFor(state({ status: "error", error: "Process exited with code 1." }))!;
    expect(crashed.status).toBe("failed");

    const stopped = notificationFor(
      state({ status: "error", error: "Terminated by user." }),
      { status: "stopped" },
    )!;
    expect(stopped.status).toBe("stopped");
  });

  test("carries the agent's answer and what it cost", () => {
    const n = notificationFor(
      state({ type: "agent", status: "done" }),
      { result: "the parser is fine", usage: { totalTokens: 900, toolUses: 4, durationMs: 1200 } },
    )!;
    expect(n.result).toBe("the parser is fine");
    expect(n.usage).toEqual({ totalTokens: 900, toolUses: 4, durationMs: 1200 });
  });

  test("an empty result is not a section", () => {
    expect(notificationFor(state(), { result: "" })!.result).toBeUndefined();
  });

  test("a long result is bounded and says so", () => {
    const n = notificationFor(state(), { result: "y".repeat(9000) })!;
    expect(n.result!.length).toBeLessThan(9000);
    expect(n.result).toContain("truncated");
  });
});

describe("formatTaskNotifications", () => {
  test("nothing queued is nothing said", () => {
    expect(formatTaskNotifications([])).toBe("");
  });

  test("the block names the task, where its output is, and how it ended", () => {
    const text = formatTaskNotification(notification());
    expect(text).toContain("<task-notification>");
    expect(text).toContain("<task-id>b1234567</task-id>");
    expect(text).toContain("<output-file>/tmp/task-outputs/b1234567.log</output-file>");
    expect(text).toContain("<status>completed</status>");
    expect(text).toContain("<summary>Background command &quot;".replace("&quot;", '"'));
    expect(text).toContain("</task-notification>");
  });

  test("a summary with markup in it cannot escape the block", () => {
    const text = formatTaskNotification(
      notification({ summary: 'ran `a < b && c > d`' }),
    );
    expect(text).toContain("a &lt; b &amp;&amp; c &gt; d");
    expect(text).not.toContain("a < b && c > d");
  });

  test("usage and result ride along when there are any", () => {
    const text = formatTaskNotification(
      notification({
        result: "done, nothing to fix",
        usage: { totalTokens: 900, toolUses: 4, durationMs: 1200 },
      }),
    );
    expect(text).toContain("<result>done, nothing to fix</result>");
    expect(text).toContain("<total_tokens>900</total_tokens>");
    expect(text).toContain("<tool_uses>4</tool_uses>");
    expect(text).toContain("<duration_ms>1200</duration_ms>");
  });

  test("a failed task's tail is shown, so the reason is the first thing read", () => {
    const text = formatTaskNotification(notification({ status: "failed", tail: "TypeError: x is not a function" }));
    expect(text).toContain("Last output:");
    expect(text).toContain("TypeError: x is not a function");
  });

  test("several notifications are headed as several, and say they are not the user", () => {
    const text = formatTaskNotifications([notification(), notification({ taskId: "b7654321" })]);
    expect(text).toContain("2 background tasks finished");
    expect(text).toContain("not messages from the user");
    expect(text).toContain("<task-id>b1234567</task-id>");
    expect(text).toContain("<task-id>b7654321</task-id>");
    expect(text).toContain("TaskOutput");
  });

  test("one notification is headed in the singular", () => {
    expect(formatTaskNotifications([notification()])).toContain(
      "A background task finished since your last turn",
    );
  });
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

describe("the notification queue", () => {
  test("a drain returns everything queued and empties the queue", () => {
    pushTaskNotification(notification({ taskId: "b1" }));
    pushTaskNotification(notification({ taskId: "b2" }));

    expect(takeTaskNotifications().map((n) => n.taskId)).toEqual(["b1", "b2"]);
    expect(pendingTaskNotificationCount()).toBe(0);
    expect(takeTaskNotifications()).toEqual([]);
  });

  test("a task notifies once, even if its state changes again after finishing", () => {
    expect(pushTaskNotification(notification())).toBe(true);
    expect(pushTaskNotification(notification({ summary: "something else" }))).toBe(false);
    expect(takeTaskNotifications().length).toBe(1);

    // Drained or not, the task already had its say.
    expect(pushTaskNotification(notification())).toBe(false);
    expect(takeTaskNotifications()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The registry: every terminal transition notifies, exactly once
// ---------------------------------------------------------------------------

describe("background tasks notify the model when they finish", () => {
  let dir: string;
  let prevData: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dc-notifications-"));
    prevData = process.env.DEEPSEEK_CODE_DATA_DIR;
    process.env.DEEPSEEK_CODE_DATA_DIR = dir;
    resetTaskNotifications();
  });

  afterEach(() => {
    if (prevData === undefined) delete process.env.DEEPSEEK_CODE_DATA_DIR;
    else process.env.DEEPSEEK_CODE_DATA_DIR = prevData;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  async function settled(id: string, timeoutMs = 5000): Promise<TaskState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = getTask(id);
      if (task && task.status !== "running") return task;
      if (Date.now() > deadline) throw new Error(`task ${id} never finished`);
      await Bun.sleep(20);
    }
  }

  test("a command that succeeds reports completed with its output path", async () => {
    const task = registerTask("echo hello from the background", { cwd: dir });
    await settled(task.id);

    const queued = takeTaskNotifications();
    expect(queued.length).toBe(1);
    expect(queued[0]!.taskId).toBe(task.id);
    expect(queued[0]!.status).toBe("completed");
    expect(queued[0]!.type).toBe("shell");
    expect(readFileSync(queued[0]!.outputPath, "utf-8")).toContain(
      "hello from the background",
    );
  });

  test("a command that fails reports failed and hands over the reason", async () => {
    const task = registerTask("echo 'kaboom: bad flag' >&2; exit 3", { cwd: dir });
    await settled(task.id);

    const queued = takeTaskNotifications();
    expect(queued.length).toBe(1);
    expect(queued[0]!.status).toBe("failed");
    expect(queued[0]!.summary).toContain('Background command "echo');
    expect(queued[0]!.tail).toContain("kaboom: bad flag");
  });

  test("a task the user stops is stopped, not a crash", async () => {
    const task = registerTask("sleep 30", { cwd: dir });
    // Let it actually start, so the kill has a process to signal.
    await Bun.sleep(150);
    const result = killTask(task.id);
    expect(result.killed).toBe(true);
    await settled(task.id);

    const queued = takeTaskNotifications();
    expect(queued.length).toBe(1);
    expect(queued[0]!.status).toBe("stopped");
    expect(queued[0]!.summary).toContain("was stopped");
  });

  test("a task that reports again does not repeat itself", async () => {
    const task = registerTask("true", { cwd: dir });
    await settled(task.id);
    expect(takeTaskNotifications().length).toBe(1);

    // The registry can be updated after a task has ended (the /tasks view
    // does it). That must not become a second, contradictory notification.
    const { updateTaskState } = await import("./backgroundFramework.js");
    updateTaskState(task.id, { status: "error", error: "Process killed." });
    expect(takeTaskNotifications()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Delivery: the engine really sends the notification to the provider
// ---------------------------------------------------------------------------

/**
 * The queue and the registry are ours; whether the model can be *told* is the
 * engine's. `Session.addUser` appends a turn and `sendStream` appends another,
 * so the model ends up with two consecutive user turns — the notification and
 * the prompt. That is the whole delivery mechanism, so it is worth proving at
 * the boundary it depends on: a real OpenAI-compatible endpoint, the real
 * addon, and the request body it actually sent.
 */
describe("delivery through the native session", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let requests: any[] = [];

  const chunk = (delta: any, finish: string | null = null) => ({
    id: "x",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-chat",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    requests = [];
  });

  function serve(): number {
    requests = [];
    const started = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push(await req.json());
        const body =
          [chunk({ role: "assistant", content: "Understood." }), chunk({}, "stop")]
            .map((c) => `data: ${JSON.stringify(c)}\n\n`)
            .join("") + "data: [DONE]\n\n";
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    server = started;
    // `port` is optional in Bun's types (the unix-socket overload); this is a
    // TCP server bound to port 0, so it always has one.
    return started.port!;
  }

  test("the notification reaches the provider as its own turn, before the prompt", async () => {
    const port = serve();
    const { Agent, Session, createDeepSeek } = await import("ai-sdk-cpp");
    const provider = createDeepSeek({ apiKey: "test", baseUrl: `http://localhost:${port}` });
    const agent = new Agent({
      model: provider("deepseek-chat"),
      tools: [],
      instructions: "You are a test.",
      maxSteps: 2,
    });
    const memoryDir = mkdtempSync(join(tmpdir(), "dc-notif-session-"));
    const session = new Session(agent, { memoryDir });

    try {
      // The real path: enqueue, drain, hand the text to the engine.
      pushTaskNotification(
        notification({
          taskId: "b0feed",
          status: "failed",
          summary: 'Background command "bun test" failed',
          tail: "1 fail: expected 2, got 3",
        }),
      );
      const news = formatTaskNotifications(takeTaskNotifications());
      session.addUser(news);

      for await (const _ev of session.sendStream("now fix it") as AsyncGenerator<any>) {
        // Drain the turn; the assertion is about the request it produced.
      }

      expect(requests.length).toBe(1);
      const sent = requests[0]!.messages;
      const roles = sent.map((m: any) => m.role);
      expect(roles[0]).toBe("system");
      // Two user turns, in order: the news, then the request.
      expect(roles.slice(1)).toEqual(["user", "user"]);
      expect(sent[1]!.content).toContain("<task-notification>");
      expect(sent[1]!.content).toContain("<task-id>b0feed</task-id>");
      expect(sent[1]!.content).toContain("<status>failed</status>");
      expect(sent[1]!.content).toContain("1 fail: expected 2, got 3");
      expect(sent[1]!.content).toContain("This is a system notification, not a message from the user");
      expect(sent[2]!.content).toBe("now fix it");
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring: the loop is where a notification turns into a turn
// ---------------------------------------------------------------------------

describe("the loop drains notifications into the next turn", () => {
  const app = readSourceFile(join(import.meta.dir, "../../components/App.tsx"), "utf-8");

  test("the send path appends the news before it sends the prompt", () => {
    const take = app.indexOf("const finishedTasks = takeTaskNotifications();");
    // The indentation is part of the anchor on purpose: `// session.addUser(…)`
    // is not a delivery, and a comment must not be able to satisfy this.
    const append = app.indexOf("\n          session.addUser(taskNews);");
    const send = app.indexOf("const events = query({", append);

    expect(take).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(take);
    expect(send).toBeGreaterThan(append);

    // …and only when there is news: an empty turn would be a lie about the
    // conversation (the model would see the user say nothing).
    expect(app.slice(take, append)).toContain("if (taskNews)");
  });

  test("the user can see what the model was told", () => {
    expect(app).toContain("pushSystem(`↩ Told the model: ${task.summary}`)");
  });

  test("the registry notifies from the one place every task ends", () => {
    const framework = readSourceFile(
      join(import.meta.dir, "backgroundFramework.ts"),
      "utf-8",
    );
    const update = framework.indexOf("export function updateTaskState(");
    const push = framework.indexOf("pushTaskNotification(notification)", update);
    expect(update).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(update);
    // The transition guard, not a status check: a task already terminal when
    // the patch arrives must not notify again.
    expect(framework.slice(update, push)).toContain("!wasTerminal && isTerminalTaskStatus");
  });

  test("headless --print drains it too, and says so if it cannot", () => {
    // The TUI was fixed and the headless entry point was not: `--print` built
    // its session, ran one send and returned, so a background task that
    // finished mid-run was reported to nobody and the queue was discarded at
    // exit. CI reads exit 0 as a finished job.
    const print = readSourceFile(join(import.meta.dir, "../../cli/print.ts"), "utf-8");
    const drain = print.indexOf("formatTaskNotifications(takeTaskNotifications())");
    const send = print.indexOf("session.sendStream(");
    expect(drain).toBeGreaterThan(-1);
    // The drain is inside the send loop: it has to run after a turn, not
    // before the one send this file used to make.
    expect(drain).toBeGreaterThan(send);
    // Feeding it back is another send of the drained text, not a print.
    expect(print).toContain("nextPrompt = news;");

    // Bounded, and what is dropped is reported rather than silently lost.
    expect(print).toContain("MAX_NOTIFICATION_TURNS");
    expect(print).toContain("pendingTaskNotificationCount()");
    expect(print).toContain("were not delivered");
  });

  test("the tool descriptions no longer promise a notification nobody sends", () => {
    const prompt = readSourceFile(
      join(import.meta.dir, "../../tools/TaskOutputTool/prompt.ts"),
      "utf-8",
    );
    expect(prompt).toContain("When you receive a notification");
    // …and that promise is now kept by a module that exists and is wired in.
    expect(app).toContain('from "../services/tasks/notifications.js"');
  });
});
