/**
 * The `!` sequence, driven through real terminal bytes.
 *
 * The first implementation kept `!` in the input value and hid it from the
 * render, while the editor kept its own buffer — so `!`, then `ls`, ran the
 * literal command `!ls`. Claude Code's model is different: `!` on an empty
 * prompt is consumed as a mode switch, the buffer holds the command alone,
 * and Enter runs that command. This test types the exact sequence against a
 * real Ink app so the desync cannot come back.
 */
import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import TextInput from "../../src/components/TextInput.js";
import { LONE_ESC_HOLD_MS, createSanitizedStdin } from "../../src/components/inkStdin.js";

class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode() {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

class FakeStdout extends PassThrough {
  columns = 120;
  rows = 40;
  isTTY = true;
  getColorDepth() {
    return 1;
  }
  hasColors() {
    return false;
  }
}

interface Captured {
  value: string;
  mode: "prompt" | "bash";
  submits: Array<{ value: string; mode: "prompt" | "bash" }>;
}

let mounted: { unmount: () => void } | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function type(...chunks: string[]): Promise<Captured> {
  const state: Captured = { value: "", mode: "prompt", submits: [] };
  function Wrap() {
    const [value, setValue] = React.useState("");
    const [mode, setMode] = React.useState<"prompt" | "bash">("prompt");
    state.value = value;
    state.mode = mode;
    return React.createElement(TextInput, {
      value,
      mode,
      onChange: setValue,
      onModeChange: setMode,
      onSubmit: () => state.submits.push({ value, mode }),
      isLoading: false,
    });
  }
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const app = render(React.createElement(Wrap), {
    stdin: createSanitizedStdin(stdin as unknown as NodeJS.ReadStream),
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
  });
  mounted = app;
  for (const chunk of chunks) {
    stdin.write(chunk);
    await Bun.sleep(15);
  }
  // Give a trailing lone Esc its ambiguity window to flush.
  await Bun.sleep(LONE_ESC_HOLD_MS + 30);
  return state;
}

test("! switches the mode without joining the command", async () => {
  const state = await type("!", "l", "s");
  expect(state.mode).toBe("bash");
  // The bug this guards: the buffer must not be "!ls".
  expect(state.value).toBe("ls");
});

test("Enter submits the bare command in shell mode", async () => {
  const state = await type("!", "l", "s", "\r");
  expect(state.submits).toEqual([{ value: "ls", mode: "bash" }]);
});

test("backspace at the start leaves shell mode and keeps the text", async () => {
  const state = await type("!", "l", "s", "\x7f", "\x7f", "\x7f");
  // The two backspaces above delete the command; the third finds cursor 0 and
  // is the reference's exit-mode key. The text is gone either way, but the
  // mode must be back to prompt.
  expect(state.value).toBe("");
  expect(state.mode).toBe("prompt");
});

test("Esc at the start leaves shell mode with the command intact", async () => {
  // Ctrl+A moves the caret to offset 0 first; the reference exits special
  // modes there (PromptInput's key handler), while App exits from anywhere.
  const state = await type("!", "l", "s", "\x01", "\x1b");
  expect(state.value).toBe("ls");
  expect(state.mode).toBe("prompt");
});
