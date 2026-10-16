/**
 * Permission dialogues: clicking a row focuses it and — for plain rows —
 * selects it, exactly as Enter would. Input rows focus (become editable)
 * without submitting.
 *
 * These dispatch synthetic events through the registered handlers: the rows
 * are the regions, so row identity is the registration order, and the
 * geometry itself is Task 1's already-tested job.
 *
 * Mounting goes through the Task 3 harness: PermissionSelect listens for keys
 * (useInput), and ink refuses to mount it off a raw-mode-capable stdin — the
 * harness supplies fake TTY streams and hands back the registry.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { PermissionSelect } from "../../src/components/PermissionPrompt.js";
import AskUserQuestionsPrompt from "../../src/components/AskUserQuestionsPrompt.js";
import type { AskUserQuestion } from "../../src/types/index.js";
import type { AskUserQuestionsResult } from "../../src/Tool.js";
import {
  createHitTester,
  elementRect,
  type RegionClickEvent,
} from "../../src/components/mouseRegions.js";
import { mountWithMouse, settle, write, type MountedMouseApp } from "./mouseTestHarness.js";

let mounted: { unmount: () => void } | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const click: RegionClickEvent = { row: 0, col: 0, clickCount: 1, button: 0, width: 40, height: 1 };

/** Mount and return the app (for follow-up keystrokes and hit testing) plus
 *  the registered handlers in render (row) order. */
async function mountRows(node: React.ReactElement): Promise<{
  app: MountedMouseApp;
  handlers: Array<(ev: RegionClickEvent) => void>;
}> {
  const app = mountWithMouse(node);
  mounted = app;
  await Bun.sleep(5);
  return {
    app,
    handlers: [...app.registry.regions.values()].map((r) => r.handlerRef.current),
  };
}

/** Mount and return the registered handlers in render (row) order. */
async function rowHandlers(node: React.ReactElement): Promise<Array<(ev: RegionClickEvent) => void>> {
  return (await mountRows(node)).handlers;
}

describe("permission select rows", () => {
  test("clicking a plain row focuses and selects it", async () => {
    const selected: string[] = [];
    const focused: string[] = [];
    const handlers = await rowHandlers(
      React.createElement(PermissionSelect, {
        options: [
          { type: "text", label: "Yes", value: "yes" },
          { type: "text", label: "No", value: "no", description: "deny it" },
        ],
        onSelect: (v: string) => selected.push(v),
        onCancel: () => {},
        onFocusChange: (v: string) => focused.push(v),
        onInputModeToggle: () => {},
      } as never),
    );
    expect(handlers.length).toBe(2);
    handlers[1]!(click);
    expect(focused).toContain("no");
    expect(selected).toEqual(["no"]);
  });

  test("clicking an input row focuses it without submitting", async () => {
    const selected: string[] = [];
    const focused: string[] = [];
    const handlers = await rowHandlers(
      React.createElement(PermissionSelect, {
        options: [
          { type: "text", label: "Yes", value: "yes" },
          {
            type: "input",
            label: "Don't ask again",
            value: "dont-ask",
            inputValue: "",
            onChange: () => {},
            placeholder: "prefix",
          },
        ],
        onSelect: (v: string) => selected.push(v),
        onCancel: () => {},
        onFocusChange: (v: string) => focused.push(v),
        onInputModeToggle: () => {},
      } as never),
    );
    handlers[1]!(click);
    expect(focused).toContain("dont-ask");
    expect(selected).toEqual([]);
  });

  test("clicking the already-focused first row selects it", async () => {
    const selected: string[] = [];
    const handlers = await rowHandlers(
      React.createElement(PermissionSelect, {
        options: [{ type: "text", label: "Yes", value: "yes" }],
        onSelect: (v: string) => selected.push(v),
        onCancel: () => {},
        onInputModeToggle: () => {},
      } as never),
    );
    handlers[0]!(click);
    expect(selected).toEqual(["yes"]);
  });
});

const multiQuestion: AskUserQuestion = {
  question: "Which fruit?",
  header: "fruit",
  multiSelect: true,
  options: [
    { label: "Apple", description: "a" },
    { label: "Banana", description: "b" },
  ],
};

describe("ask-user-question rows", () => {
  test("a multi-select option row toggles (Space semantics)", async () => {
    const results: AskUserQuestionsResult[] = [];
    const { app, handlers } = await mountRows(
      React.createElement(AskUserQuestionsPrompt, {
        questions: [multiQuestion],
        onResult: (r: AskUserQuestionsResult) => results.push(r),
      } as never),
    );
    // Rows: 0 Apple, 1 Banana, 2 Other, 3 Chat.
    expect(handlers.length).toBe(4);
    handlers[1]!(click);
    await Bun.sleep(5);
    expect(results).toEqual([]); // multi-select does not submit

    // Continue and submit: the clicked row must be in the answer payload.
    // This is the assertion that fails if clickRow stops calling toggleRow
    // (a bare "nothing submitted" check passes either way).
    await write(app, "\r"); // Enter continues from the question
    await write(app, "\r"); // Enter submits from the review view
    expect(results).toEqual([
      { kind: "answered", answers: { [multiQuestion.question]: "Banana" } },
    ]);
  });

  test("a right press on an option row does not answer; a left press on it does", async () => {
    const results: AskUserQuestionsResult[] = [];
    const app = mountWithMouse(
      React.createElement(AskUserQuestionsPrompt, {
        questions: [
          {
            question: "Which fruit?",
            header: "fruit",
            options: [
              { label: "Apple", description: "a" },
              { label: "Banana", description: "b" },
            ],
          } satisfies AskUserQuestion,
        ],
        onResult: (r: AskUserQuestionsResult) => results.push(r),
      } as never),
    );
    mounted = app;
    await settle();

    // The Banana row, located through yoga rather than by hand.
    const row = [...app.registry.regions.values()][1]!;
    const rect = elementRect(row.ref.current);
    expect(rect).toBeDefined();
    const hit = createHitTester(app.registry);

    // Right press: claimed (swallowed whole) but inert — activation is
    // left-click-only, so the question must not be answered.
    expect(hit(rect!.top, rect!.left, 1, 2)).toBe(true);
    await Bun.sleep(5);
    expect(results).toEqual([]);

    // The same cell on a left press answers and submits.
    expect(hit(rect!.top, rect!.left, 1, 0)).toBe(true);
    await Bun.sleep(5);
    expect(results).toMatchObject([{ kind: "answered", answers: { "Which fruit?": "Banana" } }]);
  });

  test("a single-select option row answers and submits", async () => {
    const results: Array<{ kind: string }> = [];
    const handlers = await rowHandlers(
      React.createElement(AskUserQuestionsPrompt, {
        questions: [
          {
            question: "Which fruit?",
            header: "fruit",
            options: [
              { label: "Apple", description: "a" },
              { label: "Banana", description: "b" },
            ],
          } satisfies AskUserQuestion,
        ],
        onResult: (r: { kind: string }) => results.push(r),
      } as never),
    );
    handlers[1]!(click);
    await Bun.sleep(5);
    expect(results[0]?.kind).toBe("answered");
  });

  test("the Other row focuses without answering; the Chat row clarifies", async () => {
    const results: Array<{ kind: string }> = [];
    const handlers = await rowHandlers(
      React.createElement(AskUserQuestionsPrompt, {
        questions: [multiQuestion],
        onResult: (r: { kind: string }) => results.push(r),
      } as never),
    );
    handlers[2]!(click); // Other
    await Bun.sleep(5);
    expect(results).toEqual([]);
    handlers[3]!(click); // Chat about this
    await Bun.sleep(5);
    expect(results[0]?.kind).toBe("clarify");
  });
});
