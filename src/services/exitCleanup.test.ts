/**
 * The teardown registry itself: every cleanup runs, exactly once, and one
 * failure never blocks the rest. The process is going away either way — a
 * half-run teardown beats a teardown that stopped at the first throw.
 */
import { describe, expect, test } from "bun:test";
import { onExitCleanup, runExitCleanups } from "./exitCleanup.js";

describe("runExitCleanups", () => {
  test("runs cleanups in registration order", () => {
    const order: string[] = [];
    onExitCleanup(() => order.push("first"));
    onExitCleanup(() => order.push("second"));

    runExitCleanups();

    expect(order).toEqual(["first", "second"]);
  });

  test("drains the list, so a later run does not repeat them", () => {
    let runs = 0;
    onExitCleanup(() => {
      runs++;
    });

    runExitCleanups();
    runExitCleanups();

    expect(runs).toBe(1);
  });

  test("a throwing cleanup does not stop the ones after it", () => {
    const ran: string[] = [];
    onExitCleanup(() => {
      throw new Error("boom");
    });
    onExitCleanup(() => ran.push("survived"));

    runExitCleanups();

    expect(ran).toEqual(["survived"]);
  });
});
