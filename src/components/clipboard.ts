/**
 * Clipboard reading, for right-click paste (pi parity: right-click in the
 * prompt pastes). Writing lives in useMouseSelection's copyToClipboard; this
 * is the read side, behind a seam so component tests never spawn pbpaste.
 *
 * pbpaste on macOS — the same platform scope as the pbcopy path — and null
 * elsewhere: there is no portable way to read a clipboard, and a failed read
 * is always a silent no-op.
 */
let readerOverride: (() => string | null) | null = null;

export function __setClipboardReaderForTests(fn: (() => string | null) | null): void {
  readerOverride = fn;
}

export function readClipboardText(): string | null {
  if (readerOverride) {
    const text = readerOverride();
    return text && text.length > 0 ? text : null;
  }
  if (process.platform !== "darwin") return null;
  try {
    const { execSync } = require("node:child_process");
    const text = execSync("pbpaste", { encoding: "utf8" });
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
