/**
 * A click must never be typed.
 *
 * `useMouseWheelScroll` turns terminal mouse reporting on for the whole
 * session (`?1000h ?1002h ?1006h`), so *every* `useInput` handler in the tree
 * receives SGR reports as input. Ink gives them an empty key name, so a
 * handler that inserts what it is handed turns a click's coordinates into
 * text — the reported symptom was `❯ [<0;23;16M]` sitting in the prompt.
 *
 * The first guard was shape-anchored: `/^\[<\d+;\d+;\d+[Mm]$/` matched a
 * string that was exactly one report and let anything else through. That is
 * only correct while a chunk is guaranteed to be one report, which it is not
 * — the terminal writes the press and the release as separate sequences and a
 * single read can hand ink both, or a report plus a real keystroke. So the
 * guard is now structural: strip the reports, keep whatever else was in the
 * chunk.
 *
 * The pure cases below pin the shapes; the component cases pin the outcome,
 * because "nothing was typed" is the thing the user actually reported.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import MultilineTextInput from "../../src/components/MultilineTextInput.js";
import HistorySearch from "../../src/components/HistorySearch.js";
import { createSanitizedStdin } from "../../src/components/inkStdin.js";
import { isMouseSequence, stripMouseSequences } from "../../src/components/useMouseWheelScroll.js";

const ESC = "\x1b";
/** A report as the terminal writes it. */
const report = (btn: number, col: number, row: number, final = "M") =>
  `${ESC}[<${btn};${col};${row}${final}`;

describe("stripMouseSequences", () => {
  test("removes a lone press, ESC and all", () => {
    expect(stripMouseSequences(report(0, 23, 16))).toBe("");
  });

  test("removes one with the leading ESC already stripped by ink", () => {
    // This is the shape a useInput handler actually sees.
    expect(stripMouseSequences("[<0;23;16M")).toBe("");
  });

  test("removes a press and its release batched into one chunk", () => {
    // Both reports carry their ESC here — the terminal's own framing.
    expect(stripMouseSequences(report(0, 23, 16) + report(0, 23, 16, "m"))).toBe("");
  });

  test("removes a release that lost its ESC to ink's strip", () => {
    expect(stripMouseSequences("[<0;23;16M" + report(0, 23, 16, "m"))).toBe("");
  });

  test("removes a drag burst", () => {
    const burst = report(32, 23, 16) + report(32, 24, 16) + report(32, 25, 16);
    expect(stripMouseSequences(burst)).toBe("");
  });

  test("removes wheel notches, including a modifier bit", () => {
    expect(stripMouseSequences("[<64;10;15M")).toBe("");
    expect(stripMouseSequences("[<80;10;15M")).toBe(""); // 64 | ctrl
    expect(stripMouseSequences("[<65;10;15M")).toBe("");
  });

  test("keeps a keystroke that was glued to a click", () => {
    expect(stripMouseSequences("[<0;23;16M" + "a")).toBe("a");
  });

  test("keeps a keystroke the click followed", () => {
    expect(stripMouseSequences("a" + report(0, 23, 16))).toBe("a");
  });

  test("keeps the text around a click in the middle of a paste", () => {
    expect(stripMouseSequences("before" + report(0, 23, 16) + "after")).toBe("beforeafter");
  });

  test("leaves ordinary input alone", () => {
    for (const text of ["hello", "a[b]", "[<", "[<0;23;16]", "ls -la | grep x"]) {
      expect(stripMouseSequences(text)).toBe(text);
    }
  });
});

describe("isMouseSequence", () => {
  test("is true for a chunk that is nothing but reports", () => {
    expect(isMouseSequence("[<0;23;16M")).toBe(true);
    expect(isMouseSequence("[<0;23;16M" + report(0, 23, 16, "m"))).toBe(true);
  });

  test("is false when a keystroke came with the click", () => {
    // The old anchored test got this wrong in the other direction: it rejected
    // the whole chunk, so the letter was lost along with the sequence.
    expect(isMouseSequence("[<0;23;16M" + "a")).toBe(false);
    expect(isMouseSequence("a" + report(0, 23, 16))).toBe(false);
  });

  test("is false for ordinary input and for the empty string", () => {
    for (const text of ["", "hello", "[<", "a[b]"]) {
      expect(isMouseSequence(text)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The component, against a real ink app and real terminal bytes
// ---------------------------------------------------------------------------

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

let mounted: { unmount: () => void } | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function type(...chunks: string[]): Promise<string> {
  let value = "";
  function Wrap() {
    const [state, setState] = React.useState("");
    value = state;
    return React.createElement(MultilineTextInput, {
      value: state,
      onChange: (next: string) => setState(next),
      onSubmit: () => {},
      focus: true,
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
  await Bun.sleep(30);
  return value;
}

describe("a click on the prompt", () => {
  test("types nothing", async () => {
    expect(await type(report(0, 23, 16))).toBe("");
  });

  test("types nothing when press and release share a write", async () => {
    // One read, two sequences — the framing a real click arrives in.
    expect(await type(report(0, 23, 16) + report(0, 23, 16, "m"))).toBe("");
  });

  test("types nothing for a click inside a word being typed", async () => {
    expect(await type("he", report(0, 23, 16) + report(0, 23, 16, "m"), "llo")).toBe("hello");
  });

  test("does not eat the keystroke it was batched with", async () => {
    expect(await type(report(0, 23, 16) + "a")).toBe("a");
  });

  test("does not eat a wheel notch's neighbours", async () => {
    expect(await type("a", report(64, 10, 15) + "b", "c")).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// A field that had no guard at all
// ---------------------------------------------------------------------------

/**
 * The fields that insert typed text are not all the prompt. The history
 * picker's search box only rejects ctrl/meta/tab — every other report went
 * straight into the query, which is the same symptom in a different place:
 * click while the picker has focus and `[<0;23;16M` is what you are searching
 * for. These mount the real component and read the frame, because "the
 * sequence is on the screen" is the report.
 */
async function typeInto(node: React.ReactElement, ...chunks: string[]): Promise<string> {
  let out = "";
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  const app = render(node, {
    stdin: createSanitizedStdin(stdin as unknown as NodeJS.ReadStream),
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  mounted = app;
  for (const chunk of chunks) {
    stdin.write(chunk);
    await Bun.sleep(15);
  }
  await Bun.sleep(30);
  return out;
}

const historyPicker = () =>
  React.createElement(HistorySearch, {
    entries: ["first prompt", "second prompt"],
    onPick: () => {},
    onClose: () => {},
  });

describe("the history picker's search box", () => {
  test("types a click's coordinates nowhere on the screen", async () => {
    const frame = await typeInto(historyPicker(), report(0, 23, 16) + report(0, 23, 16, "m"));
    expect(frame).not.toContain("[<0;23");
    expect(frame).not.toContain("[<");
  });

  test("still types real characters", async () => {
    // The control: the guard must not be so eager that it swallows the search.
    const frame = await typeInto(historyPicker(), "second");
    expect(frame).toContain("second");
  });
});
