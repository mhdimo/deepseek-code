/**
 * What /context puts on screen.
 *
 * The view is a port of Claude Code's ContextVisualization, and the parts that
 * drifted were all layout: the grid and the legend were stacked instead of
 * side by side, the legend rows padded their labels and prefixed counts with a
 * "~", the item rows said "tok", the free-space row sat after the autocompact
 * row, and the whole thing ended in a summary block the reference does not
 * have. None of that is visible in a unit test of the estimates, so the view
 * is rendered and the frame is read back.
 *
 * The custom-agent section is fed from a fixture: the test runs in a sandbox
 * directory with one `.claude/agents/echo.md`, so the section exists here
 * whatever the machine's global agents and plugin skills happen to be.
 */
import { afterAll, expect, test } from "bun:test";
import React from "react";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const sandbox = mkdtempSync(join(tmpdir(), "dsc-context-view-"));
const dataDir = join(sandbox, "data");
mkdirSync(join(sandbox, ".claude", "agents"), { recursive: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  join(sandbox, ".claude", "agents", "echo.md"),
  "---\nname: echo\ndescription: Echoes a prompt back\n---\nRepeat what you are told.\n",
);

const savedDataDir = process.env.DEEPSEEK_CODE_DATA_DIR;
process.env.DEEPSEEK_CODE_DATA_DIR = dataDir;

const { renderToString } = await import("ink");
const { default: ContextView } = await import("../../src/components/ContextView");

const budget = { maxContextTokens: 100_000, reservedForResponse: 8_000 } as never;

function render(inputTokens: number, outputTokens: number, messages: unknown[]): string {
  return renderToString(
    React.createElement(ContextView, {
      inputTokens,
      outputTokens,
      budget,
      messages: messages as never,
      model: "deepseek-chat",
      mcpServers: {},
      onClose: () => {},
    }),
  );
}

// Agent discovery is cwd-relative, so the frames are rendered inside the
// sandbox and the working directory is put back before any test runs.
const originalCwd = process.cwd();
process.chdir(sandbox);
const frame = render(12_000, 3_400, [{ role: "user", content: "hi" }]);
const emptyFrame = render(0, 0, []);
process.chdir(originalCwd);

afterAll(() => {
  process.chdir(originalCwd);
  if (savedDataDir === undefined) delete process.env.DEEPSEEK_CODE_DATA_DIR;
  else process.env.DEEPSEEK_CODE_DATA_DIR = savedDataDir;
  rmSync(sandbox, { recursive: true, force: true });
});

test("grid sits on the left with the token line and legend to its right", () => {
  // One line carries both the grid squares and the model/token summary; the
  // stacked layout put them on separate lines with the grid full width.
  expect(frame).toMatch(/⛁[^\n]*deepseek-chat · [\d.]+k?\/[\d.]+k? tokens \([\d.]+%\)/);
  expect(frame).toContain("Estimated usage by category");
});

test("legend rows read as 'label: N tokens (P%)'", () => {
  // Colon straight after the label, no 24-column gutter, no "~" (the reference
  // reserves "~" for savings estimates).
  expect(frame).toMatch(/⛁ System prompt: [\d.]+k? tokens \([\d.]+%\)/);
  expect(frame).not.toMatch(/System prompt\s{3,}/);
  expect(frame).not.toMatch(/~[\d.]+k? tokens/);
});

test("free space is printed before the autocompact buffer", () => {
  const free = frame.indexOf("Free space:");
  const reserved = frame.indexOf("Autocompact buffer:");
  expect(free).toBeGreaterThan(-1);
  expect(reserved).toBeGreaterThan(-1);
  expect(free).toBeLessThan(reserved);
});

test("item rows say 'tokens', not 'tok', and drop the estimate tilde", () => {
  expect(frame).toMatch(/└ echo: [\d.]+k? tokens/);
  expect(frame).not.toMatch(/~[\d.]+k? tok(?!en)/);
});

test("the agents section hints /agents and the heading is 'Context Usage'", () => {
  expect(frame).toContain("Context Usage");
  expect(frame).not.toContain("Context usage");
  expect(frame).toContain("Custom agents");
  expect(frame).toMatch(/ · \/agents/);
  expect(frame).not.toMatch(/ · \/agent(?!s)/);
});

test("no trailing summary block past the suggestions", () => {
  expect(frame).not.toContain("Per-category numbers are estimates");
  expect(frame).not.toContain("usable after reserving");
  expect(frame).not.toContain("Used: ");
});

test("a fresh session renders the grid and legend rather than an empty state", () => {
  expect(emptyFrame).not.toContain("No context used yet");
  expect(emptyFrame).toContain("Context Usage");
  expect(emptyFrame).toContain("0/100.0k tokens (0.0%)");
  expect(emptyFrame).toContain("Free space:");
  expect(emptyFrame).toContain("Autocompact buffer:");
});
