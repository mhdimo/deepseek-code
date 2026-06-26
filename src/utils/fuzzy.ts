// Lightweight fuzzy matcher for input autocomplete (history search, @-files).
//
// Scoring: an exact substring match ranks highest (earlier + shorter = better);
// otherwise we fall back to an ordered subsequence match that rewards consecutive
// characters. Returns 0 when the query can't be matched at all.

export function fuzzyScore(query: string, text: string): number {
  if (!query) return 1; // empty query weakly matches everything
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  const sub = t.indexOf(q);
  if (sub >= 0) {
    // Substring match: earlier position and shorter target rank higher.
    return 1000 - sub + Math.max(0, 300 - text.length);
  }

  // Ordered subsequence match.
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1 + streak;
      streak++;
      qi++;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return 0; // not every query char matched
  return score;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Filter + rank items by fuzzy score against a query, best first, capped. */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  getText: (item: T) => string,
  limit = 8,
): Scored<T>[] {
  const scored: Scored<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, getText(item));
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Detect a pending "@mention" token at the end of an input string (cursor
 * assumed at end). Returns the @ position and the query text after it, or null
 * when no open mention is present.
 */
export function detectTrailingMention(value: string): { atPos: number; query: string } | null {
  const idx = value.lastIndexOf("@");
  if (idx < 0) return null;
  const after = value.slice(idx + 1);
  if (after.includes(" ") || after.includes("@")) return null; // token already closed
  if (idx > 0 && !/\s/.test(value[idx - 1]!)) return null; // @ must be at a word boundary
  return { atPos: idx, query: after };
}
