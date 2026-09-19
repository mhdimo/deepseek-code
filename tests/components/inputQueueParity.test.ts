import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { render } from "ink";
import chalk from "chalk";

import TextInput, {
  exampleCommands,
  getSuggestion,
} from "../../src/components/TextInput.js";
import QueuePreview from "../../src/components/QueuePreview.js";
import FileMentions from "../../src/components/FileMentions.js";
import { setThemeMode, theme } from "../../src/utils/theme.js";

/* Ink styles text through chalk's default instance, and the suite's fake
   stdout is not a TTY, so chalk resolves level 0 and drops every colour and
   attribute — a stripped frame cannot tell a bold blue glyph from a plain one.
   Turn the level back on, and pin the palette so the expectations below do not
   depend on the terminal the suite happens to run in. */
chalk.level = 3;
setThemeMode("dark");

const COLUMNS = 60;
Object.defineProperty(process.stdout, "columns", { value: COLUMNS, configurable: true });

/** Ink's escape prefix for a theme colour token ("rgb(r, g, b)"). */
function escapeFor(token: string, background = false): string {
  const m = /^rgb\((\d+), ?(\d+), ?(\d+)\)$/.exec(token);
  if (!m) throw new Error(`expected an rgb token, got ${token}`);
  const rgb = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  const painted = background
    ? chalk.bgRgb(...rgb)("|")
    : chalk.rgb(...rgb)("|");
  return painted.slice(0, painted.indexOf("|"));
}

const fgEscape = (token: string): string => escapeFor(token);
const bgEscape = (token: string): string => escapeFor(token, true);

/** The prompt glyph and its non-breaking space (U+00A0), as upstream has it. */
const POINTER = "❯\u00a0";

/** Strip escape sequences, for assertions about the text alone. */
const plain = (frame: string): string =>
  frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

async function renderFrame(node: React.ReactElement): Promise<string> {
  let out = "";
  const stdout = Object.assign(new EventEmitter(), {
    columns: COLUMNS,
    rows: 40,
    isTTY: true,
    write: (chunk: string) => {
      out += chunk;
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as NodeJS.ReadStream;

  const { unmount, cleanup } = render(node, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  unmount();
  cleanup();
  return out;
}

const prompt = (props: Partial<Parameters<typeof TextInput>[0]> = {}) =>
  renderFrame(
    React.createElement(TextInput, {
      value: "",
      onChange: () => {},
      onSubmit: () => {},
      isLoading: false,
      workingDirectory: "/tmp/proj",
      ...props,
    }),
  );

/* ---------------------------------------------------------------- queued */

test("renders every queued message as its own ❯ prompt row", async () => {
  const frame = await renderFrame(
    React.createElement(QueuePreview, { queueItems: ["first", "second"] }),
  );
  const lines = frame.split("\n").filter((line) => plain(line).trim() !== "");
  expect(lines.map((line) => plain(line).trim())).toEqual([
    "❯ first",
    "❯ second",
  ]);
});

test("drops the queue count, the ▸ bullet, the +N overflow and the Ctrl+Q hint", async () => {
  const frame = await renderFrame(
    React.createElement(QueuePreview, { queueItems: ["first", "second", "third"] }),
  );
  const text = plain(frame);
  expect(text).not.toContain("3 queued");
  expect(text).not.toContain("▸");
  expect(text).not.toContain("+2 more");
  expect(text).not.toContain("Ctrl+Q");
});

test("shows the whole queued message instead of a 60-character preview", async () => {
  const message = `start ${"y".repeat(70)} END`;
  const frame = await renderFrame(
    React.createElement(QueuePreview, { queueItems: [message] }),
  );
  // The wrap the terminal forces is not a truncation: every character of the
  // queued message survives, tail included.
  expect(plain(frame).replace(/[\s ]+/g, "")).toContain("END");
  expect(plain(frame)).not.toContain("…");
});

test("indents the queued rows two columns under a blank line", async () => {
  const frame = await renderFrame(
    React.createElement(QueuePreview, { queueItems: ["first"] }),
  );
  const [first, second] = frame.split("\n");
  expect(plain(first!)).toBe(""); // marginTop=1
  expect(plain(second!)).toStartWith("  ❯ first");
});

test("paints the queued rows as prompts: subtle pointer, text body, user-message band", async () => {
  const frame = await renderFrame(
    React.createElement(QueuePreview, { queueItems: ["first"] }),
  );
  expect(frame).toContain(
    bgEscape(theme.userMessageBackground) +
      // The queue rows copy the message-body renderer, which spells the
      // pointer's trailing space as an ordinary one.
      fgEscape(theme.subtle) +
      "❯ " +
      fgEscape(theme.text) +
      "first",
  );
});

/* -------------------------------------------------------------- prompt row */

test("the prompt glyph is plain default text — no bold, no agent colour", async () => {
  const frame = await prompt();
  expect(frame).toContain("\n" + POINTER);
  expect(frame).not.toContain("\x1b[1m"); // bold
  expect(frame).not.toContain(fgEscape(theme.claude));
});

test("dims the glyph only while a turn runs", async () => {
  const loading = await prompt({ isLoading: true });
  expect(loading).toContain(`${chalk.dim(POINTER)}`);
  const idle = await prompt({ isLoading: false });
  expect(idle).toContain("\n" + POINTER);
  expect(idle).not.toContain(chalk.dim(POINTER));
});

test("starts the glyph in the first column, aligned with the rules", async () => {
  const frame = await prompt({ value: "draft" });
  const glyphLine = frame.split("\n").find((line) => line.includes("❯"));
  expect(plain(glyphLine!)).toStartWith(POINTER + "draft");
});

test("draws both rules in the promptBorder token", async () => {
  const frame = await prompt();
  expect(frame).toContain(fgEscape(theme.promptBorder));
  // chalk's "gray" (bright black) is what a literal colour would emit, and it
  // does not follow /theme.
  expect(frame).not.toContain("\x1b[90m");
});

/* The prompt row is a single Box whose left and right edges are striped off,
   so its round border prints a plain full-width rule above the input and
   another below it — in the promptBorder token, with nothing written into
   either line. (The reference embeds only the fast-mode icon in the top one;
   the working directory is never part of it.) */
test("draws the prompt's rules from the border, with nothing printed into them", async () => {
  const frame = await prompt({ value: "draft", workingDirectory: "/tmp/proj" });
  const lines = frame.split("\n").map(plain);
  const rule = "─".repeat(COLUMNS);
  expect(lines[0]).toBe(rule);
  expect(lines[1]).toStartWith(POINTER + "draft");
  expect(lines[2]).toBe(rule);
});

test("paints both rules with the promptBorder token, edge to edge", async () => {
  const frame = await prompt({ value: "draft" });
  const lines = frame.split("\n");
  const paint = fgEscape(theme.promptBorder);
  // The top rule shares its line with ink's frame markers; the bottom one is
  // the whole line.
  expect(lines[0]).toContain(paint + "─".repeat(COLUMNS));
  expect(lines[2]).toBe(paint + "─".repeat(COLUMNS) + "\x1b[39m");
});

test("prints the waiting notice above the prompt when a dialog is pending", async () => {
  const frame = await prompt({ waitingPermission: true });
  expect(frame).toContain(`\n  ${chalk.dim("Waiting for permission…")}`);
  const idle = await prompt({ waitingPermission: false });
  expect(idle).not.toContain("Waiting for permission");
});

/* ------------------------------------------------------------- placeholder */

/* The reference's set verbatim (src/utils/exampleCommands.ts), in its order.
   The four slots that name a file show `<filepath>` until the reference has a
   frequently-edited file cached; we have the file the app last touched. */
const REFERENCE_EXAMPLES = [
  "fix lint errors",
  "fix typecheck errors",
  "how does <filepath> work?",
  "refactor <filepath>",
  "how do I log an error?",
  "edit <filepath> to...",
  "write a test for <filepath>",
  "create a util logging.py that...",
];

/** The example the prompt is offering, or "" when it shows none. */
const offeredExample = (frame: string): string =>
  /Try "[^"]*"/.exec(plain(frame))?.[0] ?? "";

/* The prompt wraps one example in double quotes. Expectations below are built
   from the literal set, never from exampleCommands() — a test that asks the
   module under test what the right answers are cannot see a wrong set. */
const offered = (examples: string[]): string[] =>
  examples.map((command) => `Try "${command}"`);

const offeredFor = (file: string): string[] =>
  offered(REFERENCE_EXAMPLES.map((c) => c.replaceAll("<filepath>", file)));

test("keeps the idle example while a turn runs", async () => {
  const frame = await prompt({ isLoading: true });
  expect(plain(frame)).toContain('Try "');
  expect(plain(frame)).not.toContain("queue next message");
});

test("offers the queued-message edit hint once something is queued", async () => {
  const frame = await prompt({ isLoading: true, queueCount: 2 });
  const text = plain(frame);
  expect(text).toContain("Press up to edit queued messages");
  expect(text).not.toContain("(2 queued)");
  expect(text).not.toContain("Type and press Enter");
});

test("quotes the example with double quotes", async () => {
  const text = plain(await prompt());
  expect(text).toMatch(/Try "[^']+"/);
  expect(text).not.toContain("Try '");
});

test("offers the reference's eight examples, in its order", () => {
  expect(exampleCommands("<filepath>")).toEqual(REFERENCE_EXAMPLES);
});

test("names the frequent file in the reference's four slots", () => {
  expect(exampleCommands("QueryEngine.ts")).toEqual(
    REFERENCE_EXAMPLES.map((command) =>
      command.replaceAll("<filepath>", "QueryEngine.ts"),
    ),
  );
});

test("never offers anything outside the reference's eight", () => {
  // 64 cwds of increasing length walk every residue of the picker's hash. The
  // path is a full one, so a leaked directory would fall outside the set.
  const allowed = offeredFor("QueryEngine.ts");
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const suggestion = getSuggestion("/" + "a".repeat(i), [
      "src/components/QueryEngine.ts",
    ]);
    expect(allowed).toContain(suggestion);
    seen.add(suggestion);
  }
  expect([...seen].sort()).toEqual([...allowed].sort());
});

test("fills the prompt's example from the file the app last touched", async () => {
  const text = plain(await prompt({ recentFiles: ["src/components/QueryEngine.ts"] }));
  expect(offeredFor("QueryEngine.ts")).toContain(offeredExample(text));
  expect(text).not.toContain('Try "explain');
});

test("falls back to the reference's <filepath> with no file to name", async () => {
  const text = plain(await prompt({ recentFiles: [] }));
  expect(offered(REFERENCE_EXAMPLES)).toContain(offeredExample(text));
  expect(text).not.toContain("project structure");
});

/* ------------------------------------------------------ multi-line drafts */

test("adds no newline legend under a multi-line draft", async () => {
  const frame = await prompt({ value: "one\ntwo" });
  expect(plain(frame)).not.toContain("enter to submit");
  expect(plain(frame)).not.toContain("alt+enter");
});

/* ----------------------------------------------------------------- cursor */

test("inverts the terminal's colours for the cursor block", async () => {
  const frame = await prompt({ value: "hi" });
  expect(frame).toContain(`\x1b[7mh\x1b[27m`);
  expect(frame).not.toContain(bgEscape(theme.promptBorder));
});

/* ---------------------------------------------------------- file mentions */

test("lists matches with neither a header nor a hint footer", async () => {
  const frame = await renderFrame(
    React.createElement(FileMentions, {
      matches: ["src/a.ts", "src/components/b.tsx"],
      selectedIndex: 0,
      query: "src",
    }),
  );
  const text = plain(frame);
  expect(text).not.toContain("files matching");
  expect(text).not.toContain("shown");
  expect(text).not.toContain("Tab insert");
  expect(text).not.toContain("↑↓ navigate");
  expect(text).not.toContain("Esc dismiss");
});

test("marks the selection by colour only, with a + prefix on every row", async () => {
  const frame = await renderFrame(
    React.createElement(FileMentions, {
      matches: ["src/a.ts", "src/components/b.tsx"],
      selectedIndex: 1,
      query: "b",
    }),
  );
  expect(frame).toContain(chalk.dim("+ src/a.ts"));
  expect(frame).toContain(
    fgEscape(theme.suggestion) + "+ src/components/b.tsx",
  );
  expect(frame).not.toContain("▶");
  expect(frame).not.toContain("\x1b[36m"); // cyan pointer
  expect(frame).not.toContain("\x1b[1m"); // bold selected row
  expect(frame).not.toContain(chalk.dim("+ src/components/b.tsx"));
});
