/**
 * Pasted text, as the input buffer should see it.
 *
 * A terminal hands a paste over as one `data` chunk, and ink parses that chunk
 * with `parseKeypress` before any `useInput` handler sees it. Three shapes
 * matter, and all three are pinned against ink's real parser in paste.test.ts
 * rather than remembered:
 *
 *   "foo\r\nbar"                    name "" → the whole chunk arrives as `input`
 *   "a\x1b[31mred\x1b[0m"           name "" → the SGR bytes survive into `input`
 *                                    (inkStdin.ts filters these out before ink
 *                                    sees them at all — this is the second
 *                                    layer, and the one that knows they are not
 *                                    text rather than that they are not keys)
 *   "\x1b[200~foo\r\nbar\x1b[201~"  name undefined → ink drops the leading ESC,
 *                                    so `input` starts life as "[200~…\x1b[201~"
 *
 * That third shape is why the markers below carry two spellings: by the time
 * we can do anything about it the opening one has lost its ESC, and the
 * closing one has not.
 *
 * What went wrong without this module: the paste branch inserted the chunk
 * verbatim, so a multi-line paste became one logical line threaded with CRs
 * (`value.includes("\n")` stayed false, so the multi-line editor never engaged
 * and ink — which does not sanitise control bytes on output — drew it as
 * garbage); and because it bailed unless every character was printable, a
 * selection copied out of a coloured terminal — which is the entire reason
 * paste-as-plain-text exists — was dropped whole, with nothing said.
 *
 * So: keep what the user meant, drop what the terminal added.
 */

const PASTE_MARKER_SOURCE = "\\x1b\\[200~|\\x1b\\[201~|\\[200~|\\[201~";
const PASTE_MARKERS = new RegExp(PASTE_MARKER_SOURCE, "g");
const HAS_PASTE_MARKER = new RegExp(PASTE_MARKER_SOURCE);

// Escape sequences a terminal embeds in a selection. Ordered longest-first:
// an OSC body can contain a CSI, so it has to come off before the CSI pass.
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g; // ESC ] … BEL | ST
const CSI = /\x1b\[[0-9;?]*[\x20-\x2f]*[\x40-\x7e]/g; // ESC [ params final
const TWO_BYTE_ESC = /\x1b[@-Z\\-_]/g; // ESC + a single byte
const LONE_ESC = /\x1b/g; // anything left is a stray, not text

/** Control bytes that are never text: everything below space but tab and
 *  newline, plus DEL. Two patterns because `.test` on a /g regex is stateful. */
// eslint-disable-next-line no-control-regex
const NON_TEXT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
// eslint-disable-next-line no-control-regex
const HAS_NON_TEXT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const HAS_CR_OR_ESC = /[\r\x1b]/;

/**
 * Remove the escape sequences a terminal adds, keeping the text underneath.
 *
 * Exported for the tests: the paste pipeline is the interesting part, but this
 * is the half that decides whether a copied `git diff` survives at all.
 */
export function stripAnsi(text: string): string {
  return text.replace(OSC, "").replace(CSI, "").replace(TWO_BYTE_ESC, "").replace(LONE_ESC, "");
}

/**
 * The text a paste chunk should put in the buffer.
 *
 * Returns "" when the chunk was nothing but terminal noise, so the caller can
 * skip the insert rather than commit an empty edit (which would push a
 * keystroke's worth of history for nothing).
 */
export function normalizePaste(text: string): string {
  // Fast path: ordinary typing is one printable character with no CR and no
  // ESC, and it has to come out the other side byte-identical.
  if (!HAS_PASTE_MARKER.test(text) && !HAS_CR_OR_ESC.test(text) && !HAS_NON_TEXT_CONTROL.test(text)) {
    return text;
  }

  let out = text.replace(PASTE_MARKERS, "");
  out = stripAnsi(out);
  // CR and CRLF are what a terminal sends for a line break in a paste; the
  // buffer speaks LF. (A lone CR that arrives as its own event is Enter, and
  // never reaches here — parseKeypress gives it name "return".)
  out = out.replace(/\r\n?/g, "\n");
  return out.replace(NON_TEXT_CONTROL, "");
}

/** Whether a chunk opens a bracketed paste without closing it. */
export function opensPaste(text: string): boolean {
  const start = text.includes("\x1b[200~") || text.includes("[200~");
  const end = text.includes("\x1b[201~") || text.includes("[201~");
  return start && !end;
}

/** Whether a chunk closes a bracketed paste. */
export function closesPaste(text: string): boolean {
  return text.includes("\x1b[201~") || text.includes("[201~");
}

/**
 * How long an unclosed paste keeps its claim on the Enter key.
 *
 * A paste arrives as one chunk *per read*, so a large one is several, and a
 * split can land exactly on a line break — at which point the lone CR looks
 * like the user pressing Enter and submits half a sentence. The open marker is
 * the only warning we get, and the close marker is what ends it. The timeout
 * is for the paste that never closes — a terminal that sends the opening
 * marker and nothing else would otherwise hold Enter hostage for the session.
 */
export const PASTE_STALE_MS = 2000;

/** Whether an opened-and-unclosed paste should still swallow Enter. */
export function pasteInFlight(open: boolean, openedAt: number, now: number): boolean {
  return open && now - openedAt < PASTE_STALE_MS;
}
