/**
 * Background shells must not outlive the app that started them.
 *
 * A task is spawned detached — its own process group, no terminal — which is
 * what makes it killable as a tree, but also means nothing else will ever reap
 * it: the OS keeps running it after the app is gone. The last test here starts
 * a task in a real child process and lets that process exit, which is the
 * defect stated plainly: the shell survived.
 *
 * `DEEPSEEK_CODE_DATA_DIR` sends task output to a scratch directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getTask,
  getTaskOutputDir,
  killAllTasks,
  registerTask,
  registerVirtualTask,
  stopAllTasks,
} from "./backgroundFramework.js";

const sandbox = mkdtempSync(join(tmpdir(), "bgtasks-"));
process.env.DEEPSEEK_CODE_DATA_DIR = sandbox;

/** A pid is "alive" until it is reaped — kill(pid, 0) is enough for that. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive(pid)) {
    await new Promise((wake) => setTimeout(wake, 25));
  }
  return !alive(pid);
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (value === undefined && Date.now() < deadline) {
    await new Promise((wake) => setTimeout(wake, 25));
    value = read();
  }
  return value;
}

afterAll(async () => {
  await stopAllTasks(1000);
  delete process.env.DEEPSEEK_CODE_DATA_DIR;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("stopAllTasks", () => {
  test("kills the shell and the children in its process group", async () => {
    const task = registerTask("sleep 30 & echo $! > child.pid; wait", { cwd: sandbox });
    expect(task.pid).toBeDefined();

    const childPid = await waitFor(() => {
      try {
        return Number.parseInt(readFileSync(join(sandbox, "child.pid"), "utf-8").trim(), 10);
      } catch {
        return undefined;
      }
    });
    expect(childPid).toBeDefined();
    expect(alive(task.pid!)).toBe(true);
    expect(alive(childPid!)).toBe(true);

    expect(await stopAllTasks(4000)).toBeGreaterThanOrEqual(1);

    // Both, not just the leader: killing `sh` alone would orphan `sleep 30`.
    expect(await waitGone(task.pid!)).toBe(true);
    expect(await waitGone(childPid!)).toBe(true);
  });

  test("waits for a shell that takes a moment to die", async () => {
    // The trap makes `sh` survive the first SIGTERM by ~0.4s. Checking without
    // polling is the assertion: by the time stopAllTasks resolves, it is gone.
    const task = registerTask("trap 'sleep 0.4; exit 0' TERM; sleep 30", { cwd: sandbox });
    expect(task.pid).toBeDefined();

    await stopAllTasks(5000);

    expect(alive(task.pid!)).toBe(false);
  });

  test("is a no-op when nothing is running", async () => {
    const task = registerTask("true", { cwd: sandbox });
    await waitFor(() => (getTask(task.id)?.status === "running" ? undefined : true));

    expect(await stopAllTasks(500)).toBe(0);
  });
});

describe("killAllTasks", () => {
  test("ignores tasks that already finished", async () => {
    const task = registerTask("true", { cwd: sandbox });
    await waitFor(() => (getTask(task.id)?.status === "running" ? undefined : true));

    expect(killAllTasks()).toBe(0);
  });

  test("runs a virtual task's kill hook and marks it terminated", () => {
    let aborted = false;
    const task = registerVirtualTask("agent", "Explore the repo", {
      onKill: () => {
        aborted = true;
      },
    });

    expect(killAllTasks()).toBe(1);
    expect(aborted).toBe(true);
    expect(getTask(task.id)?.status).toBe("error");
  });
});

describe("when the process that started a task exits", () => {
  test("the task dies with it", async () => {
    const pidFile = join(sandbox, "spawned.pid");
    const goFile = join(sandbox, "go");
    rmSync(pidFile, { force: true });
    rmSync(goFile, { force: true });

    const modulePath = join(import.meta.dir, "backgroundFramework.ts");
    const script = join(sandbox, "spawner.ts");
    writeFileSync(
      script,
      `import { existsSync, writeFileSync } from "fs";\n` +
        `import { registerTask } from ${JSON.stringify(modulePath)};\n` +
        `const task = registerTask("sleep 30", { cwd: ${JSON.stringify(sandbox)} });\n` +
        `writeFileSync(${JSON.stringify(pidFile)}, String(task.pid));\n` +
        // Stay alive until the parent says go, so the task's liveness can be
        // checked *before* the exit — otherwise the check races the kill.
        `while (!existsSync(${JSON.stringify(goFile)})) {\n` +
        `  await new Promise((wake) => setTimeout(wake, 20));\n` +
        `}\n` +
        `process.exit(0);\n`,
      "utf-8",
    );

    const proc = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
    const pid = await waitFor(() => {
      try {
        return Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      } catch {
        return undefined;
      }
    });
    expect(pid).toBeDefined();
    expect(alive(pid!)).toBe(true);

    writeFileSync(goFile, "");
    await proc.exited;
    expect(await waitGone(pid!)).toBe(true);
  });
});

describe("task output", () => {
  test("lives under the app's data dir", () => {
    expect(getTaskOutputDir()).toBe(join(sandbox, "task-outputs"));
  });
});
