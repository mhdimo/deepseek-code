/**
 * Ctrl+C is the key people press by reflex to make a thing stop, so the cost
 * of getting it wrong is a lost session. It has been wrong twice: Ink's default
 * `exitOnCtrlC` swallowed the press before any handler ran (so the app quit
 * immediately and the double-press protocol was unreachable), and once that was
 * off, the overlays that own the keyboard drifted out of the handler one at a
 * time — Ctrl+C inside the ctrl+r picker fell through to "exit" because
 * `showHistorySearch` had never been added to the list.
 *
 * The second failure is a drift failure, so the tests come in two halves: the
 * precedence itself (driven as data, no rendering), and a guard that the list
 * of overlays in the handler still matches the type it is typed against and the
 * closers it has to reach.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT_ARM_WINDOW_MS,
  ctrlCAction,
  overlaysOf,
  type CtrlCState,
  type CtrlCOverlay,
} from "./ctrlC.js";

/** A CtrlCState with everything idle, overridden per test. */
function state(over: Partial<CtrlCState> = {}): CtrlCState {
  return {
    hasPendingQuestions: false,
    overlays: [],
    isLoading: false,
    hasDraft: false,
    lastCtrlCAt: 0,
    now: 10_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// What the key means
// ---------------------------------------------------------------------------

describe("ctrlCAction", () => {
  test("an idle, empty prompt arms the exit rather than exiting", () => {
    expect(ctrlCAction(state())).toEqual({ kind: "arm-exit" });
  });

  test("a second press inside the window exits", () => {
    const now = 10_000;
    expect(ctrlCAction(state({ now, lastCtrlCAt: now - 400 }))).toEqual({ kind: "exit" });
  });

  test("…and one outside the window arms again, it does not exit", () => {
    const now = 10_000;
    expect(
      ctrlCAction(state({ now, lastCtrlCAt: now - EXIT_ARM_WINDOW_MS })),
    ).toEqual({ kind: "arm-exit" });
    expect(
      ctrlCAction(state({ now, lastCtrlCAt: now - EXIT_ARM_WINDOW_MS + 1 })),
    ).toEqual({ kind: "exit" });
  });

  // The order below is the whole point: each rung must lose to the one above it.
  test("a running turn is interrupted, not the app", () => {
    const now = 10_000;
    // Armed from a previous press a moment ago — the abort still wins.
    expect(ctrlCAction(state({ now, isLoading: true, lastCtrlCAt: now - 10 }))).toEqual({
      kind: "abort",
    });
  });

  test("a draft is cleared before the turn and before the exit", () => {
    const now = 10_000;
    expect(
      ctrlCAction(state({ now, hasDraft: true, lastCtrlCAt: now - 10 })),
    ).toEqual({ kind: "clear-input" });
    // …and a draft outranks nothing else, but a running turn outranks it.
    expect(ctrlCAction(state({ now, hasDraft: true, isLoading: true }))).toEqual({
      kind: "abort",
    });
  });

  test("an open overlay closes before anything else happens", () => {
    const now = 10_000;
    expect(
      ctrlCAction(
        state({ now, overlays: ["history-search"], hasDraft: true, isLoading: true }),
      ),
    ).toEqual({ kind: "close-overlay", overlay: "history-search" });
  });

  test("the first overlay in the list is the one that closes", () => {
    expect(
      ctrlCAction(state({ overlays: ["settings", "help"] })),
    ).toEqual({ kind: "close-overlay", overlay: "settings" });
  });

  test("a question card is answered by rejection, which outranks every overlay", () => {
    // Closing the card without settling its promise would leave the model
    // waiting on an answer that can never arrive.
    expect(
      ctrlCAction(
        state({ hasPendingQuestions: true, overlays: ["transcript"], isLoading: true }),
      ),
    ).toEqual({ kind: "cancel-questions" });
  });
});

describe("overlaysOf", () => {
  test("keeps the code's order and drops what is closed", () => {
    expect(
      overlaysOf([
        ["transcript", false],
        ["settings", true],
        ["help", false],
        ["commands", true],
      ]),
    ).toEqual(["settings", "commands"]);
  });

  test("everything closed is an empty list, which is not an overlay", () => {
    const none = overlaysOf([
      ["transcript", false],
      ["commands", false],
    ]);
    expect(none).toEqual([]);
    expect(ctrlCAction(state({ overlays: none, hasDraft: true }))).toEqual({
      kind: "clear-input",
    });
  });
});

// ---------------------------------------------------------------------------
// Wiring: the handler is the list, and the list is the type
// ---------------------------------------------------------------------------

const here = import.meta.dir;
const ctrlCSource = readFileSync(join(here, "ctrlC.ts"), "utf-8");
const appSource = readFileSync(join(here, "App.tsx"), "utf-8");

/** The names in the `CtrlCOverlay` union, in the order they are written. */
function declaredOverlays(): string[] {
  const start = ctrlCSource.indexOf("export type CtrlCOverlay =");
  const end = ctrlCSource.indexOf(";", start);
  return [...ctrlCSource.slice(start, end).matchAll(/\|\s*"([a-z-]+)"/g)].map((m) => m[1]!);
}

/** The names in the handler's `overlayOpen` list, in precedence order. */
function listedOverlays(): string[] {
  const start = appSource.indexOf("const overlayOpen:");
  const end = appSource.indexOf("];", start);
  return [...appSource.slice(start, end).matchAll(/\[\s*"([a-z-]+)",/g)].map((m) => m[1]!);
}

/** The names `closeOverlay` knows how to close. */
function closedOverlays(): string[] {
  const start = appSource.indexOf("function closeOverlay(");
  const end = appSource.indexOf("\n  }\n", start);
  return [...appSource.slice(start, end).matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!);
}

describe("the overlay list cannot drift", () => {
  test("every overlay the decision can name is one the handler tracks", () => {
    const declared = declaredOverlays();
    expect(declared.length).toBeGreaterThan(8); // the union parsed at all
    expect([...listedOverlays()].sort()).toEqual([...declared].sort());
  });

  test("every overlay the handler tracks is one it can actually close", () => {
    // The failure this pins: a name added to the list but not to the switch
    // would make Ctrl+C a silent no-op — the worst outcome, since the key
    // looks like it did nothing at all.
    expect([...closedOverlays()].sort()).toEqual([...listedOverlays()].sort());
  });

  test("the full-screen takeovers answer before the popovers", () => {
    const listed = listedOverlays();
    const settings = listed.indexOf("settings");
    expect(listed.indexOf("transcript")).toBeLessThan(settings);
    expect(listed.indexOf("session-picker")).toBeLessThan(settings);
    expect(listed.indexOf("help")).toBeLessThan(listed.indexOf("history-search"));
    expect(listed.indexOf("history-search")).toBeLessThan(listed.indexOf("effort-callout"));
  });

  test("the overlays that were missing from the handler are tracked", () => {
    // The regression, named: each of these was once absent from the Ctrl+C
    // if-chain, so pressing the key inside it fell through to the exit branch.
    for (const name of ["history-search", "plugins", "effort-callout", "theme-picker"]) {
      expect(listedOverlays()).toContain(name);
      expect(closedOverlays()).toContain(name);
    }
  });

  test("the handler routes Ctrl+C through the decision module", () => {
    const handler = appSource.indexOf('if (key.ctrl && _input === "c")');
    const decide = appSource.indexOf("ctrlCAction({", handler);
    expect(handler).toBeGreaterThan(-1);
    expect(decide).toBeGreaterThan(handler);
    // …passing this component's own state, not a literal.
    const call = appSource.slice(decide, appSource.indexOf("});", decide));
    expect(call).toContain("hasPendingQuestions: pendingQuestions !== null");
    expect(call).toContain("overlays: overlaysOf(overlayOpen)");
    expect(call).toContain("isLoading");
    expect(call).toContain("hasDraft: input.length > 0");
    expect(call).toContain("lastCtrlCAt: lastCtrlCTimeRef.current");
  });

  test("every action has a branch", () => {
    // A new action kind with no branch would fall out of the switch and do
    // nothing while the handler reports success.
    for (const kind of ["cancel-questions", "close-overlay", "abort", "clear-input", "exit", "arm-exit"]) {
      expect(appSource).toContain(`case "${kind}":`);
    }
  });

  test("Ink is not allowed to eat the key before the handler sees it", () => {
    // The original defect: with Ink's default the process exits on the first
    // press and none of the above ever runs.
    const layout = readFileSync(join(here, "terminalLayout.ts"), "utf-8");
    expect(layout).toContain("exitOnCtrlC: false");
  });
});

// A compile-time reminder that the list above is exhaustive: if the union
// gains a member, this map stops being total and the tests stop compiling.
const _everyOverlayIsNamed: Record<CtrlCOverlay, true> = {
  transcript: true,
  "session-picker": true,
  settings: true,
  help: true,
  "history-search": true,
  plugins: true,
  export: true,
  "search-results": true,
  "effort-callout": true,
  "theme-picker": true,
  commands: true,
};
void _everyOverlayIsNamed;
