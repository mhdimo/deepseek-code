/**
 * A line break a read boundary cut in two.
 *
 * A terminal writes CRLF for a pasted line ending and the OS hands us what a
 * read ended at, so a paste of any size regularly arrives with a chunk ending
 * on the CR and the next beginning with the LF. Each half normalises to a line
 * feed on its own, and the break doubles: a 4KB read size adds a line every 4KB
 * of paste, so a hundred-line file pasted from a CRLF source came out double
 * spaced. The second block below is a 100KB paste that lands byte-identical to
 * `normalizePaste` of the source at every read size — it reported three extra
 * line breaks before the join existed, and the first block isolates one.
 *
 * Half of these are pure, because the state machine is where the bug was: the
 * pair is remembered across two handler calls, and nothing about that needs a
 * terminal to exercise.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import MultilineTextInput, { joinChunk } from "../../src/components/MultilineTextInput.js";
import { createSanitizedStdin } from "../../src/components/inkStdin.js";
import { normalizePaste } from "../../src/components/paste.js";

describe("joinChunk", () => {
  test("drops the LF that pairs with the CR the last chunk ended on", () => {
    expect(joinChunk("\ntwo", true)).toEqual({ text: "two", pendingCR: false });
  });

  test("keeps a leading LF that pairs with nothing", () => {
    // A blank line in a paste is two line feeds, and the first of them belongs
    // to the break before it. Eating it here would swallow the blank line.
    expect(joinChunk("\ntwo", false)).toEqual({ text: "\ntwo", pendingCR: false });
  });

  test("reports a chunk that ends on a bare CR", () => {
    expect(joinChunk("one\r", false)).toEqual({ text: "one\r", pendingCR: true });
  });

  test("a chunk ending on a whole CRLF is not half of anything", () => {
    // The break is entirely inside this chunk; the LF after it in the next
    // chunk is a real blank line.
    expect(joinChunk("one\r\n", false).pendingCR).toBe(false);
  });

  test("a CR with no LF after it is the end of the pair", () => {
    expect(joinChunk("two", true)).toEqual({ text: "two", pendingCR: false });
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

let mounted: { unmount: () => void } | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function type(...chunks: string[]): Promise<Captured> {
  const state: Captured = { value: "", submits: 0 };
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
  return state;
}

describe("a line break split across reads", () => {
  test("is one line break, not two", async () => {
    const state = await type("\x1b[200~one\r", "\ntwo\x1b[201~");
    expect(state.value).toBe("one\ntwo");
    expect(state.submits).toBe(0);
  });

  test("is one line break when the LF arrives as its own read", async () => {
    // The boundary can land with the CR as the last byte of one read and the
    // LF as the whole of the next, which is the shape ink names "enter".
    const state = await type("\x1b[200~one\r", "\n", "two\x1b[201~");
    expect(state.value).toBe("one\ntwo");
    expect(state.submits).toBe(0);
  });

  test("is one line break without bracketed markers either", async () => {
    // A terminal that never turned paste marking on still splits its reads.
    const state = await type("one\r", "\ntwo");
    expect(state.value).toBe("one\ntwo");
    expect(state.submits).toBe(0);
  });

  test("leaves a real blank line alone", async () => {
    // The guard has to be the CR, not the boundary: an LF that ends a chunk is
    // a line feed in its own right, and the LF after it is the blank line.
    const state = await type("\x1b[200~one\n", "\ntwo\x1b[201~");
    expect(state.value).toBe("one\n\ntwo");
  });

  test("does not swallow an LF the user asks for later", async () => {
    // A carried CR is spent by the next chunk: once a chunk arrives that does
    // not open with that LF, it was the end of the line and nothing more.
    const state = await type("\x1b[200~one\r", "two\x1b[201~", "\n", "\x1b[200~three\x1b[201~");
    expect(state.value).toBe("one\ntwo\nthree");
  });

  test("a bare CR mid-paste is still that line's only break", async () => {
    const state = await type("\x1b[200~one", "\r", "two\x1b[201~");
    expect(state.value).toBe("one\ntwo");
    expect(state.submits).toBe(0);
  });

  test("Enter submits again once the paste has closed", async () => {
    const state = await type("\x1b[200~one\r", "\ntwo\x1b[201~", "\r");
    expect(state.value).toBe("one\ntwo");
    expect(state.submits).toBe(1);
  });

  test("an Enter that submitted does not carry its CR into the next paste", async () => {
    // Unbracketed, so the newline the next paste opens with reaches the
    // handler as the first byte of a chunk and not behind a paste marker. An
    // Enter that submitted is done with this stream; that newline is the next
    // paste's own and has no CR to pair with.
    const state = await type("\x1b[200~one\x1b[201~", "\r", "\ntwo");
    expect(state.value).toBe("one\ntwo");
    expect(state.submits).toBe(1);
  });
});

describe("a paste long enough to be read in pieces", () => {
  test("lands exactly as its source, whatever the read size", async () => {
    const body = Array.from(
      { length: 30 },
      (_, i) => `line ${i} of a pasted block with CRLF endings`,
    ).join("\r\n");
    const bracketed = `\x1b[200~${body}\x1b[201~`;

    // Split the stream where a read really would: between the CR and the LF of
    // a break. Reverting the join doubles this one break and no other.
    const junction = bracketed.indexOf("\r\n", 100);
    expect(junction).toBeGreaterThan(0);
    const state = await type(bracketed.slice(0, junction + 1), bracketed.slice(junction + 1));

    expect(state.value).toBe(normalizePaste(body));
    expect(state.submits).toBe(0);
  });

  test("a 50KB paste lands exactly as its source at the sizes a pty reads", async () => {
    const parts: string[] = [];
    for (let i = 0; i < 400; i++) {
      parts.push(`+\tconst value${i} = compute(${i});`);
      parts.push(`-\tconst value${i - 1} = compute(${i - 1});`);
    }
    const body = parts.join("\r\n");
    const bracketed = `\x1b[200~${body}\x1b[201~`;
    const expected = normalizePaste(body);

    // 4KB and 1024 are what a pty read tends to hand over. The third size puts
    // the end of a read on this paste's own CR, so a boundary provably lands
    // mid-break rather than leaving it to which sizes happen to collide.
    const junctions = [...bracketed.matchAll(/\r\n/g)].map((m) => m.index!);
    const midBreakSize = junctions.find((at) => at > 4096)! + 1;
    expect(bracketed.slice(0, midBreakSize).endsWith("\r")).toBe(true);

    for (const size of [4096, 1024, midBreakSize]) {
      const chunks: string[] = [];
      for (let i = 0; i < bracketed.length; i += size) chunks.push(bracketed.slice(i, i + size));
      const state = await type(...chunks);
      expect(state.value, `read size ${size}`).toBe(expected);
      expect(state.submits, `read size ${size}`).toBe(0);
    }
  });
});
