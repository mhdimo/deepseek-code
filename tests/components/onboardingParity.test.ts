/**
 * The first-run screen's header and its security step.
 *
 * Three things here were visibly different from the reference: the header
 * carried an extra dim "First-time setup" row under the name, that name was
 * bold where the reference's is only accent-colored, and the security step's
 * second bullet traded the docs pointer for a prose caution. The theme step
 * also sent the user to /settings for a later change, where the reference names
 * the command that actually opens the picker.
 *
 * Render only — the assertions are about what the screen says.
 */
import { expect, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";

// The welcome line's weight is only observable if the renderer emits SGR at
// all; set the level before ink is imported (see --isolate).
const chalk = (await import("chalk")).default;
chalk.level = 3;

const { render } = await import("ink");
const { default: Onboarding } = await import("../../src/components/Onboarding");

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");
const ENTER = "\r";

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

interface Frame {
  raw: string;
  text: string;
}

async function driveOnboarding(...keys: string[]): Promise<Frame> {
  let out = "";
  const stdout = new FakeStdout();
  stdout.write = (chunk: string) => {
    out += chunk;
    return true;
  };
  const stdin = new FakeStdin();
  const app = render(
    React.createElement(Onboarding, {
      hasApiKey: true,
      initialTheme: "dark",
      version: "9.9.9",
      onDone: () => {},
    }),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: false,
    },
  );
  await Bun.sleep(50);
  for (const key of keys) {
    stdin.write(key);
    await Bun.sleep(50);
  }
  await Bun.sleep(30);
  app.unmount();
  const raw = out.split(`${ESC}[2K`).pop() ?? "";
  return { raw, text: raw.replace(ANSI, "") };
}

test("the theme step points at the theme command", async () => {
  const frame = await driveOnboarding();
  expect(frame.text).toContain("To change this later, run /theme");
  expect(frame.text).not.toContain("run /settings");
});

test("the welcome line is accent-colored, not bold", async () => {
  const frame = await driveOnboarding();
  expect(frame.text).toContain("Welcome to DeepSeek Code v9.9.9");
  const line = frame.raw.split("\n").find((l) => l.includes("Welcome to DeepSeek Code"));
  expect(line).toBeDefined();
  expect(line).not.toContain(`${ESC}[1m`);
});

test("the header is the logo block alone", async () => {
  const frame = await driveOnboarding();
  // The reference renders <WelcomeV2 /> — welcome line and version, nothing
  // else. The panel used to add a dim second title line.
  expect(frame.text).not.toContain("First-time setup");
});

test("the security step's second bullet points at the docs", async () => {
  // Enter on the theme step accepts the focused theme and moves on.
  const frame = await driveOnboarding(ENTER);
  expect(frame.text).toContain("Security notes:");
  expect(frame.text).toContain("For more details see:");
  expect(frame.text).toContain("https://api-docs.deepseek.com");
  expect(frame.text).not.toContain("Be careful with untrusted files");
  // The first bullet's pronoun is product-name grammar and stays as it is.
  expect(frame.text).toContain("You should always review its responses");
});
