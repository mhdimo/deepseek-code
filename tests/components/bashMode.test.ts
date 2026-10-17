/**
 * Shell mode's transcript row. `!command` is drawn like the reference's
 * UserBashInputMessage — a `!` pointer on the bash background — and its
 * output hangs under the same `  ⎿  ` gutter as a Bash tool result, folded
 * at three lines outside transcript mode. `!!` is visibly the excluded
 * variant, and a running command advertises Esc as the way out.
 */
import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import MessageView from "../../src/components/MessageView.js";
import StatusBar from "../../src/components/StatusBar.js";
import TextInput from "../../src/components/TextInput.js";
import type { Message } from "../../src/types/index.js";

function render(message: Message, isTranscriptMode = false): string {
  return renderToString(
    React.createElement(MessageView, {
      message,
      contentWidth: 60,
      messageStartRow: 0,
      blockKeyBase: "bash-test",
      isTranscriptMode,
      onBlockReport: () => {},
    }),
  );
}

const bashMessage = (bash: NonNullable<Message["bash"]>): Message => ({
  role: "user",
  content: "",
  timestamp: 1,
  bash,
});

const base = {
  runId: 1,
  command: "echo hi",
  output: "hi\n",
  stdout: "hi\n",
  stderr: "",
  exitCode: 0,
  status: "done" as const,
  startedAt: 1,
};

test("draws the command behind a bang pointer", () => {
  const frame = render(bashMessage(base));
  expect(frame).toContain("! ");
  expect(frame).toContain("echo hi");
});

test("hangs the output off the tool-result gutter", () => {
  const frame = render(bashMessage(base));
  expect(frame).toContain("⎿");
  expect(frame).toContain("hi");
});

test("says (No output) for a silent command", () => {
  const frame = render(bashMessage({ ...base, output: "", stdout: "" }));
  expect(frame).toContain("(No output)");
});

test("folds long output outside transcript mode and expands in it", () => {
  const output = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n");
  const collapsed = render(bashMessage({ ...base, output }));
  expect(collapsed).toContain("line 1");
  expect(collapsed).toContain("ctrl+o to expand");
  expect(collapsed).not.toContain("line 6");

  const expanded = render(bashMessage({ ...base, output }), true);
  expect(expanded).toContain("line 6");
});

test("a running command advertises Esc and shows its live tail", () => {
  const output = Array.from({ length: 7 }, (_, i) => `tick ${i + 1}`).join("\n");
  const frame = render(bashMessage({ ...base, status: "running", output, exitCode: null }));
  expect(frame).toContain("Running… (Esc to cancel)");
  expect(frame).toContain("+2 lines");
  expect(frame).toContain("tick 7");
  expect(frame).not.toContain("tick 1");
});

test("cancelled, failed and truncated runs say so", () => {
  expect(render(bashMessage({ ...base, status: "cancelled", exitCode: null }))).toContain("(cancelled)");
  expect(
    render(bashMessage({ ...base, status: "error", exitCode: 2, output: "boom\n" })),
  ).toContain("(exit 2)");
  expect(
    render(bashMessage({ ...base, truncated: true })),
  ).toContain("Output truncated at 50KB");
});

function renderPrompt(value: string, mode: "prompt" | "bash" = "prompt"): string {
  return renderToString(
    React.createElement(TextInput, {
      value,
      onChange: () => {},
      onSubmit: () => {},
      isLoading: false,
      mode,
    }),
  ).replace(/\u00a0/g, " ");
}

test("shell mode's pointer is `!` and the buffer holds the command alone", () => {
  const frame = renderPrompt("echo hi", "bash");
  expect(frame).toContain("! echo hi");
  expect(frame).not.toContain("! !echo");
  // The mode is announced by the status line, not a banner above the prompt.
  expect(frame).not.toContain("Shell mode");
});

test("prompt mode keeps the chevron", () => {
  const frame = renderPrompt("echo hi");
  expect(frame).toContain("\u276f echo hi");
});

test("the status line says shell mode while it is active", () => {
  const frame = renderToString(
    React.createElement(StatusBar, {
      model: "deepseek-flash",
      agentName: "code" as const,
      bashMode: true,
    }),
  );
  expect(frame).toContain("shell mode");
  // The regular telemetry steps aside for the duration of the mode.
  expect(frame).not.toContain("deepseek-flash");
});
