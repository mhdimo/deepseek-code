import { describe, expect, test } from "bun:test";
import { groupTasksByType, sortTasksForList } from "./TasksView.js";
import type { TaskState, TaskType } from "../Task.js";

function makeTask(
  id: string,
  type: TaskType,
  status: TaskState["status"],
  startedAt: number,
): TaskState {
  return {
    id,
    type,
    status,
    command: `workflow ${id}`,
    outputPath: `/tmp/${id}.log`,
    pid: undefined,
    startedAt,
  } as TaskState;
}

describe("sortTasksForList", () => {
  test("running tasks first, then newest startedAt", () => {
    const oldDone = makeTask("old-done", "shell", "done", 1000);
    const newDone = makeTask("new-done", "shell", "done", 3000);
    const running = makeTask("running", "shell", "running", 2000);
    const oldError = makeTask("old-error", "shell", "error", 500);

    expect(sortTasksForList([oldDone, newDone, oldError, running])).toEqual([
      running,
      newDone,
      oldDone,
      oldError,
    ]);
  });

  test("stable within equal startedAt", () => {
    const a = makeTask("a", "shell", "done", 1000);
    const b = makeTask("b", "shell", "done", 1000);
    expect(sortTasksForList([a, b])).toEqual([a, b]);
  });
});

describe("groupTasksByType", () => {
  test("section order shells → agents → workflows, empty sections omitted", () => {
    const agent = makeTask("a1", "agent", "running", 1000);
    const workflow = makeTask("w1", "workflow", "done", 1000);
    const shell = makeTask("s1", "shell", "running", 2000);
    const shell2 = makeTask("s2", "shell", "done", 500);

    const sections = groupTasksByType([agent, workflow, shell, shell2]);
    expect(sections.map((s) => s.type)).toEqual(["shell", "agent", "workflow"]);
    expect(sections[0]!.tasks).toEqual([shell, shell2]);
    expect(sections[1]!.tasks).toEqual([agent]);
    expect(sections[2]!.tasks).toEqual([workflow]);
  });

  test("sections keep their input order (already sorted by the caller)", () => {
    const running = makeTask("r", "workflow", "running", 2000);
    const done = makeTask("d", "workflow", "done", 1000);
    const sections = groupTasksByType([done, running]);
    expect(sections[0]!.tasks).toEqual([done, running]);
  });

  test("empty input → no sections", () => {
    expect(groupTasksByType([])).toEqual([]);
  });
});
