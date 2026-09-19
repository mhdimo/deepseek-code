/**
 * A rewind moves the conversation, the files, and the model's memory of both.
 *
 * The third was the one that got missed: the engine keeps its own history, and
 * a cached session ignores the `history` the app hands it, so truncating the
 * visible transcript left the model still remembering the rewound turns — and,
 * in a "both" rewind, the edits whose files had just been restored underneath
 * it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rewindPlan } from "./rewind.js";

describe("rewindPlan", () => {
  test("a conversation rewind truncates and drops the engine session", () => {
    const plan = rewindPlan("conversation");
    expect(plan.truncateConversation).toBe(true);
    expect(plan.restoreFiles).toBe(false);
    // Without this the model keeps the turns the user just rewound.
    expect(plan.dropEngineSession).toBe(true);
  });

  test("a code rewind restores files and leaves the conversation alone", () => {
    const plan = rewindPlan("code");
    expect(plan.truncateConversation).toBe(false);
    expect(plan.restoreFiles).toBe(true);
    // Nothing was truncated, so there is no history to rebuild — dropping the
    // session here would throw away a conversation that did not change.
    expect(plan.dropEngineSession).toBe(false);
  });

  test("both does everything", () => {
    const plan = rewindPlan("both");
    expect(plan.truncateConversation).toBe(true);
    expect(plan.restoreFiles).toBe(true);
    expect(plan.dropEngineSession).toBe(true);
  });

  test("dropping the session is exactly the truncating case", () => {
    // Stated as a rule rather than three literals: a fourth mode has to decide
    // this consciously, and the bug was a mode-conditional that forgot it.
    for (const mode of ["conversation", "code", "both"] as const) {
      const plan = rewindPlan(mode);
      expect(plan.dropEngineSession, `${mode} drops the session iff it truncates`).toBe(
        plan.truncateConversation,
      );
    }
  });
});

describe("wiring", () => {
  const app = readFileSync(join(import.meta.dir, "App.tsx"), "utf-8");

  test("the rewind handler asks the plan instead of re-deriving the modes", () => {
    const handler = app.slice(app.indexOf("const rewindToDepth"));
    expect(handler).toContain("rewindPlan(mode)");
    expect(handler).toContain("if (plan.truncateConversation)");
    expect(handler).toContain("if (plan.restoreFiles)");
    // The old shape — the mode conditions spelled out at each step — is what
    // let a third decision go missing.
    expect(handler.slice(0, 1200)).not.toContain('mode === "conversation"');
    expect(handler.slice(0, 1200)).not.toContain('mode === "code"');
  });

  test("dropping the cached session is inside the truncating branch", () => {
    const handler = app.slice(app.indexOf("const rewindToDepth"));
    // The guard, not just the call: the call sitting there unguarded — or
    // behind a dead condition — is the same defect with better optics.
    expect(handler).toContain("if (plan.dropEngineSession) {");
    const branch = handler.indexOf("if (plan.truncateConversation)");
    const drop = handler.indexOf("resetMemorySession()");
    expect(branch).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(branch);
    // …and before the file-restore block, so a code-only rewind cannot reach it.
    expect(drop).toBeLessThan(handler.indexOf("if (plan.restoreFiles)"));
  });
});
