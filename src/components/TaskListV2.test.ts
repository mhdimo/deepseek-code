import { describe, expect, test } from "bun:test";
import {
  computeMaxDisplay,
  getTaskIcon,
  partitionTasksForDisplay,
  sortTasksByIdAsc,
  summarizeHiddenTasks,
  todosToViewItems,
  type TaskListViewItem,
} from "./TaskListV2.js";

function makeTask(
  id: string,
  status: TaskListViewItem["status"],
  extra: Partial<TaskListViewItem> = {},
): TaskListViewItem {
  return {
    id,
    subject: `Task ${id}`,
    status,
    blockedBy: [],
    ...extra,
  };
}

describe("todosToViewItems", () => {
  test("maps positional ids and content subjects", () => {
    const items = todosToViewItems([
      { content: "Fix the tests", status: "in_progress" },
      { content: "Ship it", status: "pending" },
    ]);
    expect(items).toEqual([
      { id: "1", subject: "Fix the tests", status: "in_progress", blockedBy: [] },
      { id: "2", subject: "Ship it", status: "pending", blockedBy: [] },
    ]);
  });
});

describe("computeMaxDisplay", () => {
  test("tiny terminals show nothing", () => {
    expect(computeMaxDisplay(10)).toBe(0);
    expect(computeMaxDisplay(5)).toBe(0);
  });

  test("clamps to 3..10 around rows-14", () => {
    expect(computeMaxDisplay(24)).toBe(10);
    expect(computeMaxDisplay(14)).toBe(3);
    expect(computeMaxDisplay(13)).toBe(3);
    expect(computeMaxDisplay(100)).toBe(10);
  });
});

describe("sortTasksByIdAsc", () => {
  test("numeric ids sort numerically", () => {
    const sorted = sortTasksByIdAsc([
      makeTask("10", "pending"),
      makeTask("2", "pending"),
      makeTask("1", "pending"),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["1", "2", "10"]);
  });

  test("non-numeric ids fall back to localeCompare", () => {
    const sorted = sortTasksByIdAsc([
      makeTask("beta", "pending"),
      makeTask("alpha", "pending"),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["alpha", "beta"]);
  });

  test("does not mutate the input", () => {
    const input = [makeTask("2", "pending"), makeTask("1", "pending")];
    sortTasksByIdAsc(input);
    expect(input.map((t) => t.id)).toEqual(["2", "1"]);
  });
});

describe("partitionTasksForDisplay", () => {
  const now = 1_000_000;

  test("no truncation: everything visible, id-sorted", () => {
    const tasks = [makeTask("3", "pending"), makeTask("1", "completed")];
    const { visible, hidden } = partitionTasksForDisplay(tasks, 5, now, new Map());
    expect(visible.map((t) => t.id)).toEqual(["1", "3"]);
    expect(hidden).toEqual([]);
  });

  test("recently completed items outrank older completed ones when truncating", () => {
    const tasks = [
      makeTask("1", "completed"), // old — no timestamp
      makeTask("2", "completed"), // recent
      makeTask("3", "pending"),
    ];
    const timestamps = new Map([["2", now]]);
    const { visible, hidden } = partitionTasksForDisplay(tasks, 2, now, timestamps);
    expect(visible.map((t) => t.id)).toEqual(["2", "3"]);
    expect(hidden.map((t) => t.id)).toEqual(["1"]);
  });

  test("expired recent completions sink with the older ones", () => {
    const tasks = [
      makeTask("1", "completed"), // recent but stale
      makeTask("2", "completed"),
      makeTask("3", "pending"),
    ];
    const timestamps = new Map([["1", now - 60_000]]); // TTL is 30s
    const { visible, hidden } = partitionTasksForDisplay(tasks, 2, now, timestamps);
    expect(visible.map((t) => t.id)).toEqual(["3", "1"]);
    expect(hidden.map((t) => t.id)).toEqual(["2"]);
  });

  test("priority order when truncating: recent completed → in-progress → pending → old completed", () => {
    const tasks = [
      makeTask("1", "completed"),
      makeTask("2", "completed"),
      makeTask("3", "in_progress"),
      makeTask("4", "pending"),
      makeTask("5", "pending"),
    ];
    const timestamps = new Map([["1", now]]);
    const { visible, hidden } = partitionTasksForDisplay(tasks, 4, now, timestamps);
    expect(visible.map((t) => t.id)).toEqual(["1", "3", "4", "5"]);
    expect(hidden.map((t) => t.id)).toEqual(["2"]);
  });

  test("blocked pending tasks sink below unblocked pending when truncating", () => {
    const tasks = [
      makeTask("1", "pending"),
      makeTask("2", "pending", { blockedBy: ["9"] }), // blocked — #9 unresolved
      makeTask("3", "in_progress"),
      makeTask("4", "completed"),
    ];
    const { visible, hidden } = partitionTasksForDisplay(tasks, 3, now, new Map());
    expect(visible.map((t) => t.id)).toEqual(["3", "1", "2"]);
    expect(hidden.map((t) => t.id)).toEqual(["4"]);
  });

  test("blockedBy completed tasks does not count as blocked", () => {
    const tasks = [
      makeTask("1", "pending"),
      makeTask("2", "pending", { blockedBy: ["9"] }),
      makeTask("3", "in_progress"),
      makeTask("4", "completed"),
      makeTask("9", "completed"),
    ];
    const { visible, hidden } = partitionTasksForDisplay(tasks, 4, now, new Map());
    // #2 unblocked (its blocker is done) → id order within pending
    expect(visible.map((t) => t.id)).toEqual(["3", "1", "2", "4"]);
    expect(hidden.map((t) => t.id)).toEqual(["9"]);
  });
});

describe("summarizeHiddenTasks", () => {
  test("empty", () => {
    expect(summarizeHiddenTasks([])).toBe("");
  });

  test("all three buckets", () => {
    const hidden = [
      makeTask("1", "pending"),
      makeTask("2", "pending"),
      makeTask("3", "in_progress"),
      makeTask("4", "completed"),
    ];
    expect(summarizeHiddenTasks(hidden)).toBe(" … +1 in progress, 2 pending, 1 completed");
  });

  test("only pending", () => {
    expect(summarizeHiddenTasks([makeTask("1", "pending")])).toBe(" … +1 pending");
  });
});

describe("getTaskIcon", () => {
  test("status → icon + color", () => {
    expect(getTaskIcon("completed")).toEqual({ icon: "✓", colorToken: "success" });
    expect(getTaskIcon("in_progress")).toEqual({ icon: "▪", colorToken: "claude" });
    expect(getTaskIcon("pending")).toEqual({ icon: "▫", colorToken: undefined });
  });
});
