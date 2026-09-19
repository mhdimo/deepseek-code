import { Transform } from "node:stream";

/**
 * The filter between the terminal and ink's input parser.
 *
 * Terminal input is not all keys. A paste carries whatever bytes the source had
 * — colour codes above all, which is what a selection copied out of a coloured
 * terminal or out of this app's own transcript is made of. And ink 6.8 does not
 * check: `parseKeypress` runs a handful of regexes over the raw sequence and
 * hands the result to every `useInput` handler. For SGR — `ESC[31m`, `ESC[0m`,
 * literally any CSI that ends in a letter ink has no key for — the function
 * computes `ctrl: true` out of the parameter (`31 & 4` is truthy) and leaves
 * `name` as `undefined`, because enquirer's key table has no `[m` entry. Ink
 * then does `input = keypress.name` and `input.startsWith('\u001B')`, and the
 * process dies with `TypeError: undefined is not an object`. Not a dropped
 * character — an uncaught throw out of the app's input handler, which no
 * `useInput` callback can guard against because it happens before the callback.
 *
 * So the fix is not in the handler: it is to not hand ink those bytes. What we
 * keep is an allowlist — the sequences that are actually keys (ink's own key
 * table, the SGR mouse reports our wheel handler reads, and the bracketed-paste
 * markers), plus plain text. Everything else in the stream is terminal
 * plumbing, never typing: SGR, OSC titles and hyperlinks, device replies
 * (`ESC[12;34R`), unrecognised CSI. Dropping them is also what keeps `ESC[31m`
 * from being *typed* into the prompt in the cases where it does not crash — the
 * same bytes have the same origin, and pasting a coloured diff should insert
 * the diff.
 *
 * It is a stream filter rather than a regex over the chunk because a sequence
 * can be split across reads at any point (a paste is read in chunks), and
 * because ink's parser sees each chunk independently. Partial sequences are
 * held and joined to the next chunk, exactly as ink's own parser holds them.
 */

const ESC = "\x1b";
const BEL = "\x07";

/** Letter finals ink maps to a key when a CSI's parameters are digits only:
 *  `ESC[A` up, `ESC[B` down, `ESC[C` right, `ESC[D` left, `ESC[E` clear,
 *  `ESC[F` end, `ESC[H` home, `ESC[Z` shift+tab, and the rxvt lowercase forms
 *  `ESC[a`…`ESC[e`. Any other letter is not a key — which is precisely the set
 *  that makes ink's parser fall off its key table with `ctrl` set. */
const KEY_FINALS = "ABCDEFHZabcde";

/** First parameter of the key family that ends in `~`/`^`/`$`: function keys,
 *  nav keys, and the bracketed-paste markers (200 = open, 201 = close). */
const KEY_PARAMS = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24, 200, 201,
]);

/** A held partial sequence longer than this is noise, not a sequence being
 *  continued: an unterminated OSC would otherwise swallow the rest of the
 *  session's input while we wait for an end that is never coming. */
export const MAX_PENDING = 512;

type Parsed = { sequence: string; end: number } | "pending" | null;

/**
 * The escape sequence starting at `at`, or "pending" when the chunk ends
 * before we can tell, or null when these bytes are not a control sequence at
 * all (a lone ESC, or ESC followed by an ordinary character — a meta key,
 * which ink resolves the same way).
 */
function parseEscape(text: string, at: number): Parsed {
  const kind = text[at + 1];
  if (kind === undefined) return "pending";

  if (kind === "[") {
    let i = at + 2;
    // Legacy `ESC[[A` (Cygwin/libuv function keys) — the second `[` is a
    // parameter byte to ink, not the start of a sequence.
    if (text[i] === "[") i++;
    for (; i < text.length; i++) {
      const code = text.codePointAt(i)!;
      if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) continue;
      if (code >= 0x40 && code <= 0x7e) return { sequence: text.slice(at, i + 1), end: i + 1 };
      return null;
    }
    return "pending";
  }

  if (kind === "]") {
    // OSC — a terminal reply (window title, hyperlink, clipboard), never a key.
    const bel = text.indexOf(BEL, at + 2);
    const st = text.indexOf(`${ESC}\\`, at + 2);
    const ends = [bel, st].filter((index) => index !== -1).sort((a, b) => a - b);
    if (ends.length === 0) return "pending";
    const end = text[ends[0]!] === BEL ? ends[0]! + 1 : ends[0]! + 2;
    return { sequence: text.slice(at, end), end };
  }

  if (kind === "O") {
    // SS3 — F1–F4, arrows, home/end from the application-cursor cluster.
    const final = text[at + 2];
    if (final === undefined) return "pending";
    const code = final.codePointAt(0)!;
    if (code >= 0x40 && code <= 0x7e) return { sequence: text.slice(at, at + 3), end: at + 3 };
    return null;
  }

  return null;
}

/** True when these bytes are typing rather than terminal plumbing. */
export function isInputSequence(sequence: string): boolean {
  if (!sequence.startsWith(ESC)) return true; // plain text
  if (sequence.startsWith(`${ESC}]`)) return false; // OSC: window title, hyperlink
  if (!sequence.startsWith(`${ESC}[`)) return true; // SS3 key, or ESC + char

  const payload = sequence.slice(2, -1);
  const final = sequence.slice(-1);

  // SGR mouse reports (`ESC[<64;10;15M`), which the wheel handler reads.
  if (payload.startsWith("<")) return true;
  // Legacy Cygwin/libuv function keys.
  if (/^\[[A-E]$/.test(payload) || /^\[[56]~$/.test(payload)) return true;

  if (final === "~" || final === "^" || final === "$") {
    const first = Number.parseInt(payload.split(";")[0] ?? "", 10);
    return KEY_PARAMS.has(first);
  }

  // ink's shape for a letter-final key: nothing, digits, or `1;<digits>`.
  if (KEY_FINALS.includes(final)) return /^(?:1;)?\d*$/.test(payload);

  return false;
}

/**
 * Stateful across chunks, because a sequence can be split anywhere: the
 * terminal writes a paste in pieces and Node reads them in pieces.
 */
export class StdinSanitizer {
  private pending = "";

  push(chunk: string): string {
    const text = this.pending + chunk;
    this.pending = "";
    let out = "";
    let i = 0;

    while (i < text.length) {
      const at = text.indexOf(ESC, i);
      if (at === -1) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, at);
      const parsed = parseEscape(text, at);
      if (parsed === "pending") {
        this.pending = text.slice(at);
        break;
      }
      if (parsed === null) {
        out += ESC; // hand it on as ink would: ESC, then whatever follows
        i = at + 1;
        continue;
      }
      if (isInputSequence(parsed.sequence)) out += parsed.sequence;
      i = parsed.end;
    }

    if (this.pending.length > MAX_PENDING) this.pending = "";
    return out;
  }
}

/**
 * The stream to hand ink as `stdin`. Everything ink touches on a terminal —
 * `isTTY`, raw mode, ref/unref — is forwarded to the real one, so the wrapper
 * is invisible to it; only the bytes change.
 */
export function createSanitizedStdin(real: NodeJS.ReadStream): NodeJS.ReadStream {
  const sanitizer = new StdinSanitizer();
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const clean = sanitizer.push(text);
      if (clean.length > 0) stream.push(clean);
      callback();
    },
  }) as unknown as NodeJS.ReadStream;

  Object.defineProperty(stream, "isTTY", { value: real.isTTY, configurable: true });
  stream.setRawMode = (mode: boolean) => real.setRawMode(mode);
  stream.ref = () => real.ref();
  stream.unref = () => real.unref();

  // Decode at the real boundary, not ours: a multi-byte character split across
  // two reads has to be joined before anything decides what the bytes mean.
  real.setEncoding("utf8");
  real.pipe(stream);
  return stream;
}
