
/**
 * "ultrathink" keyword detection — Claude Code parity. Typing the word in a
 * prompt bumps that single turn's reasoning effort to high (via the session's
 * providerOptions); the keyword stays in the message and the next turn
 * reverts to the configured effort level.
 */

export interface KeywordRange {
  start: number;
  end: number;
}

/** Effort level an ultrathink turn is bumped to. Claude Code maps the
 *  keyword to "high" — and high is the strongest value our provider mapping
 *  emits, so it is both the parity choice and the ceiling. */
export const ULTRATHINK_EFFORT = "high" as const;

export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text);
}

/** Absolute [start, end) ranges of every "ultrathink" occurrence, for
 *  per-character rainbow highlighting in the input renderer. */
export function findUltrathinkPositions(text: string): KeywordRange[] {
  const ranges: KeywordRange[] = [];
  const re = /\bultrathink\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}
