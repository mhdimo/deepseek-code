/**
 * Headless auto-approval is the mode where "ask" silently becomes "allow",
 * because there is nobody to ask. That is fine for the ordinary case — it is
 * what `--print` is for — and wrong for the protected paths, where the reason
 * the file changed would have been that no one was watching.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeadlessApprover } from "./print.js";

const workingDir = mkdtempSync(join(tmpdir(), "print-approval-"));

describe("createHeadlessApprover", () => {
  test("ordinary calls are approved without asking", async () => {
    const approve = createHeadlessApprover(workingDir);
    expect(await approve("Write", "Write src/a.ts", { file_path: "src/a.ts" })).toEqual({
      approved: true,
    });
    expect(await approve("Bash", "Run npm test", { command: "npm test" })).toEqual({ approved: true });
  });

  test("a protected write is refused, with the reason the model reads", async () => {
    const approve = createHeadlessApprover(workingDir);
    const decision = await approve("Write", "Write .zshrc", { file_path: "~/.zshrc" });
    expect(decision.approved).toBe(false);
    expect(decision.feedback).toContain("a protected file (.zshrc)");
    // The refusal has to say how to proceed, or it reads as a bug.
    expect(decision.feedback).toContain("--dangerously-skip-permissions");
  });

  test("the explicit opt-in restores the old behaviour", async () => {
    const approve = createHeadlessApprover(workingDir, true);
    expect(await approve("Write", "Write .zshrc", { file_path: "~/.zshrc" })).toEqual({
      approved: true,
    });
  });

  test("reads and pathless tools are untouched", async () => {
    const approve = createHeadlessApprover(workingDir);
    expect(await approve("Read", "Read .zshrc", { file_path: "~/.zshrc" })).toEqual({ approved: true });
    expect(await approve("TodoWrite", "Update todos", { todos: [] })).toEqual({ approved: true });
  });
});

/**
 * A headless run says what it did by exit code and stdout, and a refusal
 * changes neither. The refusal reaches the model either way (it *is* the tool
 * result); the envelope is how the operator finds out, which is what makes a
 * morning's CI job that was denied every write distinguishable from one that
 * made them.
 *
 * The wrapper is where refusals are raised and `tools.permissionDenied.test.ts`
 * covers it; this is the wiring from there to the JSON.
 */
describe("the envelope carries the refusals", () => {
  const src = readFileSync(join(import.meta.dir, "print.ts"), "utf-8");

  test("the session is given the channel", () => {
    expect(src).toContain("onPermissionDenied: (toolName, reason) => {");
    expect(src).toContain("permissionDenials.push({ tool: toolName, reason })");
  });

  test("the reason is on stderr too, not only in the JSON", () => {
    // A consumer that checks the exit code and never parses the envelope still
    // has the line in its log.
    expect(src).toContain("[denied]");
  });

  test("both envelopes carry it — the success one and the error one", () => {
    // The error envelope is a second, easy-to-miss construction of PrintResult;
    // a run that failed *because* of a refusal is exactly when it matters.
    expect((src.match(/^\s*permissionDenials,$/gm) ?? []).length).toBe(2);
  });
});
