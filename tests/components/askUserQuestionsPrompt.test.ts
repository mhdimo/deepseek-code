/**
 * The AskUserQuestion prompt against the reference's two synthesized rows.
 *
 * The reference appends an "Other" input row and a "Chat about this" row under
 * the model's own options — the first lets the user answer in their own words,
 * the second hands the question back for discussion instead of answering it.
 * Ours listed bare options only, so neither escape hatch existed. Everything
 * below is invisible in a static render of the initial frame: the numbered
 * rows need the synthesized list, and the answers need keystrokes.
 */
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { AskUserQuestion } from "../../src/types/index.js";
import type { AskUserQuestionsResult } from "../../src/Tool.js";

// The dimmed index and the success-coloured marker are only observable if the
// renderer emits their SGR codes at all; set the level before ink is imported
// (see --isolate).
const chalk = (await import("chalk")).default;
chalk.level = 3;

const React = (await import("react")).default;
const { render } = await import("ink");
const { default: AskUserQuestionsPrompt } = await import("../../src/components/AskUserQuestionsPrompt");
const { clarifyFeedback } = await import("../../src/components/askUserQuestionsState");

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g");
const ENTER = "\r";
const DOWN = `${ESC}[B`;
const BACKSPACE = "\x7f";

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

interface PromptRun {
  /** The last frame, SGR codes intact. */
  raw: string;
  /** Every frame the prompt painted, codes stripped. */
  frames: string[];
  /** The last frame, codes stripped. */
  text: string;
  results: AskUserQuestionsResult[];
}

/** Mount the prompt, send each key, and hand back what it settled on. */
async function drive(
  asked: AskUserQuestion | AskUserQuestion[],
  ...keys: string[]
): Promise<PromptRun> {
  const questions = Array.isArray(asked) ? asked : [asked];
  let out = "";
  const results: AskUserQuestionsResult[] = [];
  const stdout = new FakeStdout();
  stdout.write = (chunk: string) => {
    out += chunk;
    return true;
  };
  const stdin = new FakeStdin();
  const app = render(
    React.createElement(AskUserQuestionsPrompt, {
      questions,
      onResult: (result: AskUserQuestionsResult) => results.push(result),
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
  // Read the frames before unmounting: tearing the app down repaints the
  // terminal and would leave the last chunk of the log empty.
  const chunks = out.split(`${ESC}[2K`);
  const frames = chunks.map((chunk) => chunk.replace(ANSI, ""));
  app.unmount();
  return {
    raw: chunks[chunks.length - 1] ?? "",
    frames,
    text: frames[frames.length - 1] ?? "",
    results,
  };
}

/** A three-option question, the widest an AskUserQuestion can be. */
function question(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
  return {
    question: "Which database should we use?",
    header: "Database",
    options: [
      { label: "Postgres", description: "Reliable relational store" },
      { label: "SQLite", description: "Embedded, zero-config" },
      { label: "Mongo", description: "Document store" },
    ],
    ...overrides,
  };
}

test("numbers the synthesized rows straight on from the model's options", async () => {
  const database = question();
  const run = await drive(database);

  expect(run.text).toContain("1. Postgres");
  expect(run.text).toContain("2. SQLite");
  expect(run.text).toContain("3. Mongo");
  // The reference's Other row reads as its placeholder, not as the word
  // "Other", and the single-select one ends in a period.
  expect(run.text).toContain("4. Type something.");
  expect(run.text).not.toContain("4. Other");
  expect(run.text).toContain("5. Chat about this");

  // The row order is the contract: options, then Other, then Chat about this.
  const lines = run.text.split("\n");
  const rowLine = (needle: string) => lines.findIndex((line) => line.includes(needle));
  expect(rowLine("3. Mongo")).toBeLessThan(rowLine("4. Type something."));
  expect(rowLine("4. Type something.")).toBeLessThan(rowLine("5. Chat about this"));

  // Focus opens on the first option, under the reference's pointer.
  expect(run.text).toContain("❯ 1. Postgres");
});

test("the multi-select Other row drops the sentence-ending period", async () => {
  const run = await drive(question({ multiSelect: true }));

  const other = run.text.split("\n").find((line) => line.includes("Type something"));
  expect(other).toContain("4.");
  expect(other).not.toContain("Type something.");
  // SelectMulti brackets the Other input row like any other selectable row.
  expect(other).toContain("[ ] Type something");
});

test("Enter on Chat about this hands the question back to the model", async () => {
  const database = question();
  const run = await drive(database, DOWN, DOWN, DOWN, DOWN, ENTER);

  expect(run.results).toEqual([
    { kind: "clarify", feedback: clarifyFeedback([database], {}, {}) },
  ]);
  const [result] = run.results;
  expect(result?.kind).toBe("clarify");
  expect(result?.kind === "clarify" ? result.feedback : "").toContain("Questions asked:");
  expect(result?.kind === "clarify" ? result.feedback : "").toContain(
    "Which database should we use?",
  );
});

test("Enter on an empty Other row cancels instead of answering blank", async () => {
  const run = await drive(question(), DOWN, DOWN, DOWN, ENTER);

  expect(run.results).toEqual([{ kind: "cancelled" }]);
});

test("typing into the Other row answers with the typed text", async () => {
  const database = question();
  const run = await drive(database, DOWN, DOWN, DOWN, "r", "e", "d", "i", "s", ENTER);

  expect(run.results).toEqual([
    { kind: "answered", answers: { [database.question]: "redis" } },
  ]);
});

test("a lone single-select question submits without a review step", async () => {
  const database = question();
  const run = await drive(database, ENTER);

  expect(run.results).toEqual([
    { kind: "answered", answers: { [database.question]: "Postgres" } },
  ]);
  expect(run.frames.some((frame) => frame.includes("Review your answers"))).toBe(false);
});

test("a second question still routes through the review view", async () => {
  const database = question();
  const hosting = question({ question: "Where should it run?", header: "Hosting" });
  const run = await drive([database, hosting], ENTER, ENTER);

  expect(run.results).toEqual([]);
  expect(run.text).toContain("Review your answers");
  expect(run.text).toContain("● Which database should we use?");
  expect(run.text).toContain("→ Postgres");
  expect(run.text).toContain("● Where should it run?");
  expect(run.text).toContain("Ready to submit your answers?");
  expect(run.text).toContain("Enter submits · ←/→ returns to the questions · Esc to cancel");
  // Both questions are answered, so the reference's warning stays away.
  expect(run.text).not.toContain("You have not answered all questions");

  const submitted = await drive([database, hosting], ENTER, ENTER, ENTER);
  expect(submitted.results).toEqual([
    {
      kind: "answered",
      answers: { [database.question]: "Postgres", [hosting.question]: "Postgres" },
    },
  ]);
});

test("an unanswered question warns but does not block the submission", async () => {
  const database = question();
  const extras = question({ question: "Any extras?", header: "Extras", multiSelect: true });
  // Answer the first, then continue out of the multi-select without picking.
  const run = await drive([database, extras], ENTER, ENTER);

  expect(run.text).toContain("⚠ You have not answered all questions");
  expect(run.text).toContain("● Which database should we use?");
  expect(run.text).not.toContain("● Any extras?");

  const submitted = await drive([database, extras], ENTER, ENTER, ENTER);
  expect(submitted.results).toEqual([
    { kind: "answered", answers: { [database.question]: "Postgres" } },
  ]);
});

test("Backspace deletes the last character of the Other row", async () => {
  const database = question();
  const run = await drive(database, DOWN, DOWN, DOWN, "h", "i", BACKSPACE, ENTER);

  expect(run.results).toEqual([{ kind: "answered", answers: { [database.question]: "h" } }]);
});

test("foots each mode with the reference's own guide", async () => {
  const database = question();
  const hosting = question({ question: "Where should it run?", header: "Hosting" });

  const lone = await drive(database);
  expect(lone.text).toContain("Enter to select · ↑/↓ to navigate · Esc to cancel");
  expect(lone.text).not.toContain("Tab/Arrow keys");

  const paired = await drive([database, hosting]);
  expect(paired.text).toContain("Enter to select · Tab/Arrow keys to navigate · Esc to cancel");

  const multi = await drive(question({ multiSelect: true }));
  expect(multi.text).toContain("Space toggles · Enter continues · Esc to cancel");
  expect(multi.text).not.toContain("Tab/Arrow keys");

  const pairing = await drive([question({ multiSelect: true }), database]);
  expect(pairing.text).toContain(
    "Space toggles · Enter continues · Tab/Arrow keys to navigate · Esc to cancel",
  );
});
