





export function fuzzyScore(query: string, text: string): number {
  if (!query) return 1; 
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  const sub = t.indexOf(q);
  if (sub >= 0) {
    
    return 1000 - sub + Math.max(0, 300 - text.length);
  }

  
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
  if (qi < q.length) return 0; 
  return score;
}

export interface Scored<T> {
  item: T;
  score: number;
}


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


export function detectTrailingMention(value: string): { atPos: number; query: string } | null {
  const idx = value.lastIndexOf("@");
  if (idx < 0) return null;
  const after = value.slice(idx + 1);
  if (after.includes(" ") || after.includes("@")) return null; 
  if (idx > 0 && !/\s/.test(value[idx - 1]!)) return null; 
  return { atPos: idx, query: after };
}
