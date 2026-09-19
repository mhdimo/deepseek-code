/**
 * Text-entry dialogs (/apikey, /baseurl, /statusline, add-rule, add-hook) end
 * on the shared input guide. The reference renders it through
 * KeyboardShortcutHint — plain, capitalised key names, "confirm" rather than
 * "save" — where ours had bold lower-case keys and a different verb.
 */
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

// The key names' weight is only observable if the renderer emits SGR at all;
// set the level before ink is imported (see --isolate).
const chalk = (await import("chalk")).default;
chalk.level = 3;

const React = (await import("react")).default;
const { render } = await import("ink");
const { default: InputDialog } = await import("../../src/components/InputDialog");

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");

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
  columns = 100;
  rows = 40;
  isTTY = true;
  getColorDepth() {
    return 3;
  }
  hasColors() {
    return true;
  }
}

async function frame(props: Record<string, unknown>): Promise<{ raw: string; text: string }> {
  let out = "";
  const stdout = new FakeStdout();
  stdout.write = (chunk: string) => {
    out += chunk;
    return true;
  };
  const app = render(
    React.createElement(InputDialog, {
      title: "Set the base URL",
      onSubmit: () => {},
      onCancel: () => {},
      ...props,
    }),
    {
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await Bun.sleep(50);
  app.unmount();
  const raw = out.split(`${ESC}[2K`).pop() ?? "";
  return { raw, text: raw.replace(ANSI, "") };
}

test("ends on the reference's confirm/cancel guide", async () => {
  const out = await frame({});
  expect(out.text).toContain("Enter to confirm · Esc to cancel");
  expect(out.text).not.toContain("to save");
});

test("leaves the key names unemphasised", async () => {
  const out = await frame({});
  const guide = out.raw.split("\n").find((line) => line.includes("Enter to confirm"));
  expect(guide).toBeDefined();
  // KeyboardShortcutHint's shortcut is plain: no bold around "Enter"/"Esc".
  expect(guide).not.toContain(`${ESC}[1m`);
});

test("keeps its own note when an existing value is being edited", async () => {
  const out = await frame({ initial: "https://api.deepseek.com/v1" });
  expect(out.text).toContain("Enter to confirm · Esc to cancel");
  expect(out.text).toContain("edits start from the current value");
});
