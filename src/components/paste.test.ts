/**
 * Pasting into the prompt.
 *
 * Two bugs lived here and both were silent. A multi-line paste inserted its CRs
 * verbatim, so the buffer held one logical line threaded with carriage returns
 * — the multi-line editor never engaged and ink, which does not sanitise
 * control bytes on output, drew the garbage. And the paste branch bailed unless
 * every character was printable, so a selection copied out of a coloured
 * terminal (which is the whole reason paste-as-plain-text exists) inserted
 * nothing at all, with no message.
 *
 * The shapes these tests pin are not from memory: the integration block renders
 * the real component against a real ink app and writes real terminal bytes into
 * its stdin, and what comes out is what the handler is handed. That is the only
 * way to know, because the delivery is strangled through ink's input parser
 * first — a bracketed paste does not arrive as one event but as three.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import MultilineTextInput from "./MultilineTextInput.js";
import { createSanitizedStdin } from "./inkStdin.js";
import {
  PASTE_STALE_MS,
  closesPaste,
  normalizePaste,
  opensPaste,
  pasteInFlight,
  stripAnsi,
} from "./paste.js";

// ---------------------------------------------------------------------------
// The text pipeline
// ---------------------------------------------------------------------------

describe("normalizePaste", () => {
  test("ordinary typing is untouched", () => {
    for (const typed of ["a", "Z", "9", " ", "é", "👍", "-", "/"]) {
      expect(normalizePaste(typed)).toBe(typed);
    }
  });

  test("a multi-line paste becomes line feeds, never carriage returns", () => {
    // These are exactly the bytes a terminal sends for a copied three-line
    // block: CRLF between the lines and a CR before the last (lines are
    // CR-terminated on the wire, not CRLF-terminated).
    expect(normalizePaste("one\r\ntwo\r\nthree")).toBe("one\ntwo\nthree");
    expect(normalizePaste("one\rtwo\rthree")).toBe("one\ntwo\nthree");
    expect(normalizePaste("trailing\r")).toBe("trailing\n");
  });

  test("colour a terminal embedded in the selection is stripped, not the paste", () => {
    expect(normalizePaste("a\x1b[31mred\x1b[0m")).toBe("ared");
    expect(normalizePaste("\x1b[1;32m✓\x1b[0m tests passed")).toBe("✓ tests passed");
  });

  test("an OSC title and a two-byte escape both come off", () => {
    expect(normalizePaste("\x1b]0;my title\x07hello")).toBe("hello");
    expect(normalizePaste("\x1b]8;;http://x\x07link\x1b]8;;\x07")).toBe("link");
    expect(normalizePaste("a\x1bMb")).toBe("ab");
  });

  test("the two spellings of a bracketed-paste marker come off", () => {
    // ink strips the ESC from the opening marker before we ever see it, and
    // leaves it on the closing one: both are pinned in the integration block.
    expect(normalizePaste("\x1b[200~hello\x1b[201~")).toBe("hello");
    expect(normalizePaste("[200~hello[201~")).toBe("hello");
  });

  test("stray control bytes are dropped, tabs and newlines are not", () => {
    expect(normalizePaste("a\x07b")).toBe("ab");
    expect(normalizePaste("a\tb")).toBe("a\tb");
    expect(normalizePaste("a\nb")).toBe("a\nb");
  });

  test("a chunk that was nothing but terminal noise normalises to nothing", () => {
    // The caller skips the insert on an empty result — committing it would
    // push an empty edit and a useless undo step.
    expect(normalizePaste("\x1b[31m\x1b[0m")).toBe("");
    expect(normalizePaste("\x1b[201~")).toBe("");
  });

  test("a pasted diff keeps its content, escapes and all", () => {
    const pasted = "diff --git a/x b/x\r\n\x1b[32m+added\x1b[0m\r\n\x1b[31m-removed\x1b[0m\r\n";
    expect(normalizePaste(pasted)).toBe("diff --git a/x b/x\n+added\n-removed\n");
  });
});

describe("stripAnsi", () => {
  test("removes escapes and leaves everything else", () => {
    expect(stripAnsi("\x1b[?25lhi\x1b[?25h")).toBe("hi");
    expect(stripAnsi("no escapes here")).toBe("no escapes here");
  });
});

describe("paste markers", () => {
  test("an opening marker without a closing one opens a paste", () => {
    expect(opensPaste("[200~")).toBe(true);
    expect(opensPaste("\x1b[200~")).toBe(true);
    expect(opensPaste("[200~text")).toBe(true);
  });

  test("a complete paste opens nothing — it is already over", () => {
    expect(opensPaste("[200~text[201~")).toBe(false);
    expect(opensPaste("\x1b[200~text\x1b[201~")).toBe(false);
    expect(closesPaste("\x1b[200~text\x1b[201~")).toBe(true);
  });

  test("ordinary text is neither", () => {
    expect(opensPaste("hello")).toBe(false);
    expect(closesPaste("hello")).toBe(false);
  });
});

describe("pasteInFlight", () => {
  test("an open paste holds Enter for its stated window and no longer", () => {
    expect(pasteInFlight(true, 1000, 1000)).toBe(true);
    expect(pasteInFlight(true, 1000, 1000 + PASTE_STALE_MS - 1)).toBe(true);
    expect(pasteInFlight(true, 1000, 1000 + PASTE_STALE_MS)).toBe(false);
  });

  test("a closed paste never holds it", () => {
    expect(pasteInFlight(false, 1000, 1000)).toBe(false);
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

interface Captured {
  value: string;
  submits: number;
}

/** The component, wired the way App wires it: controlled value, counted submits. */
function harness(state: Captured) {
  function Wrap() {
    const [value, setValue] = React.useState("");
    state.value = value;
    return React.createElement(MultilineTextInput, {
      value,
      onChange: (next: string) => setValue(next),
      onSubmit: () => {
        state.submits += 1;
      },
      focus: true,
    });
  }
  return Wrap;
}

let mounted: { unmount: () => void } | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function type(...chunks: string[]): Promise<Captured> {
  const state: Captured = { value: "", submits: 0 };
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const app = render(React.createElement(harness(state)), {
    // The bytes go through the same filter production installs (index.tsx):
    // ink's keypress parser throws outright on some of them, so a harness that
    // wrote straight into ink would be testing a stack the app never runs.
    stdin: createSanitizedStdin(stdin as unknown as NodeJS.ReadStream),
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
  });
  mounted = app;
  for (const chunk of chunks) {
    stdin.write(chunk);
    await Bun.sleep(15);
  }
  await Bun.sleep(25);
  return state;
}

describe("pasting into the prompt", () => {
  test("a multi-line paste lands as real newlines", async () => {
    const state = await type("one\r\ntwo\r\nthree");
    expect(state.value).toBe("one\ntwo\nthree");
    expect(state.value.includes("\n")).toBe(true);
    expect(state.value.includes("\r")).toBe(false);
    expect(state.submits).toBe(0);
  });

  test("a paste from a coloured terminal is not discarded", async () => {
    const state = await type("a\x1b[31mred\x1b[0m word");
    expect(state.value).toBe("ared word");
    expect(state.submits).toBe(0);
  });

  test("a bracketed paste arrives as three events and lands as its text", async () => {
    // The marker, the text, the marker — ink's input parser splits them, which
    // is why the component tracks an open paste rather than trusting one shape.
    const state = await type("\x1b[200~line one\r\nline two\x1b[201~");
    expect(state.value).toBe("line one\nline two");
    expect(state.value.includes("\r")).toBe(false);
    expect(state.submits).toBe(0);
  });

  test("an Enter inside a paste is a line break, not a submission", async () => {
    // The failure this prevents: a large paste is read in chunks, and a split
    // that lands on a line break hands us a bare CR that looks exactly like
    // the user pressing Enter — which submitted half a paragraph.
    const state = await type("\x1b[200~first part", "\r", "second part\x1b[201~");
    expect(state.submits).toBe(0);
    expect(state.value).toBe("first part\nsecond part");
  });

  test("once the paste closes, Enter submits again", async () => {
    const state = await type("\x1b[200~the prompt\x1b[201~", "\r");
    expect(state.value).toBe("the prompt");
    expect(state.submits).toBe(1);
  });

  test("ordinary Enter on ordinary text still submits", async () => {
    const state = await type("hello", "\r");
    expect(state.value).toBe("hello");
    expect(state.submits).toBe(1);
  });

  test("a paste whose close marker never comes does not hold Enter forever", async () => {
    // A terminal that sends the opening marker and then dies mid-paste used to
    // risk a session where Enter could never submit again.
    const state = await type("\x1b[200~orphan");
    expect(state.submits).toBe(0);
    expect(state.value).toBe("orphan");

    // Past the window the guard is spent; the next Enter submits normally.
    const stale = { open: true, openedAt: Date.now() - PASTE_STALE_MS - 1 };
    expect(pasteInFlight(stale.open, stale.openedAt, Date.now())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wiring: the terminal is asked to mark pastes at all
// ---------------------------------------------------------------------------

describe("the app asks for bracketed paste", () => {
  const source = (file: string) => readFileSync(join(import.meta.dir, file), "utf-8");
  const terminalLayout = source("terminalLayout.ts");
  const app = source("App.tsx");
  const input = source("MultilineTextInput.tsx");

  test("the mode is defined once, as the DEC private mode it is", () => {
    expect(terminalLayout).toContain('BRACKETED_PASTE_ON = "\\x1b[?2004h"');
    expect(terminalLayout).toContain('BRACKETED_PASTE_OFF = "\\x1b[?2004l"');
  });

  test("it is turned on at startup and turned back off on the way out", () => {
    // Both halves matter: leaving the terminal in bracketed-paste mode hands
    // the shell after us markers it never asked for.
    expect(app).toContain("out.write(BRACKETED_PASTE_ON)");
    expect(app).toContain("out.write(BRACKETED_PASTE_OFF)");
    // …and off on the exits that never unmount (a signal), not just the
    // unmount cleanup.
    const effect = app.indexOf("out.write(BRACKETED_PASTE_ON)");
    expect(app.slice(effect, effect + 400)).toContain("onExitCleanup(");
  });

  test("the input handler normalises rather than trusting the chunk", () => {
    expect(input).toContain("const text = normalizePaste(input);");
    // The old gate — insert only if every character is printable — is gone;
    // it is what dropped a paste containing a colour code.
    expect(input).not.toContain("isPrintable");
  });
});
