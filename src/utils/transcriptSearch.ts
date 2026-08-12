// Transcript search — ranked message matching for less-style slash-search.
//
// Powers a `/`-invoked search overlay over the conversation: type a query,
// get ranked matches with snippets and highlight offsets, then navigate
// between them with `n` (next) / `N` (previous), wrapping around. Pure TS,
// no React/Ink dependency — consumes the Message type and returns data the
// overlay renders. This mirrors the intent of Claude Code's transcript
// search but adapts to DeepSeek Code's flat `Message` shape (string content
// + optional toolUse[] + blocks[] + thinking).
//
// Search model: case-insensitive substring by default; optional regex.
// Ranking rewards earlier matches, shorter surrounding text, and matches in
// user/assistant body over tool output (which is verbose and noisy).

import type { Message, MessageBlock, ToolUseBlock } from "../types/index.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** Treat `query` as a regular expression. Default: false (substring). */
  regex?: boolean;
  /** Case-sensitive match. Default: false (case-insensitive). */
  caseSensitive?: boolean;
  /** Include assistant `thinking` text in the search corpus. Default: true. */
  includeThinking?: boolean;
  /** Include tool input/output in the corpus. Default: true. */
  includeToolContent?: boolean;
  /** Cap on returned matches. Default: 200. */
  limit?: number;
  /** Max chars of context on each side of the match in a snippet. Default: 40. */
  snippetRadius?: number;
}

/**
 * One continuous run of matched text within a single field of a message.
 * Offsets are relative to the *field* string that was searched (see
 * `SearchMatch.field`), not the whole flattened message — the overlay
 * highlights the snippet using these.
 */
export interface HighlightRange {
  /** Start offset within `field` text. */
  start: number;
  /** End offset (exclusive) within `field` text. */
  end: number;
}

/** Which part of a message a match landed in. Drives icon/label in the UI. */
export type SearchField = "content" | "thinking" | "toolInput" | "toolOutput";

export interface SearchMatch {
  /** Index into the input `messages` array. Stable identifier for navigation. */
  messageIndex: number;
  /** The field of the message the match was found in. */
  field: SearchField;
  /**
   * For tool fields, the index into `message.toolUse[]` (or `blocks[]`);
   * -1 when the match is in the top-level content/thinking.
   */
  blockIndex: number;
  /** Human-readable label, e.g. "assistant", "user", "Bash", "tool #2". */
  label: string;
  /** The full text of the field that was searched. */
  fieldText: string;
  /** All match ranges within `fieldText`, sorted ascending. */
  highlights: HighlightRange[];
  /** A short snippet centered on the first match for list rendering. */
  snippet: string;
  /** Where in `snippet` the first highlight begins (for in-snippet paint). */
  snippetHighlightStart: number;
  /** Ranking score — higher is better. Matches sort by this then by position. */
  score: number;
}

// ─── Field extraction ───────────────────────────────────────────────────────
//
// We expand each Message into a flat list of searchable (field, label, text)
// records. Keeping them separate (rather than concatenating) means snippet
// offsets are accurate and the UI can attribute a hit to a specific block.

interface SearchableField {
  messageIndex: number;
  field: SearchField;
  blockIndex: number;
  label: string;
  text: string;
}

const TOOL_INPUT_KEYS = [
  "command",
  "pattern",
  "file_path",
  "path",
  "prompt",
  "description",
  "query",
  "url",
  "skill",
  "content",
] as const;

/** Duck-type a tool input (string or parsed args JSON) for searchable text. */
function toolInputText(input: string | undefined, argsJson: string | undefined): string {
  // Prefer a parsed args object if present (richer field names); fall back
  // to the raw input string.
  let obj: unknown = undefined;
  if (argsJson) {
    try {
      obj = JSON.parse(argsJson);
    } catch {
      obj = undefined;
    }
  }
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of TOOL_INPUT_KEYS) {
      const v = o[k];
      if (typeof v === "string") parts.push(v);
    }
    // Arrays of strings (args[], files[]) — join for searchability.
    for (const k of ["args", "files", "paths"] as const) {
      const v = o[k];
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        parts.push((v as string[]).join(" "));
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return typeof input === "string" ? input : "";
}

/** Extract searchable fields from a single Message. */
function extractFields(
  msg: Message,
  index: number,
  opts: SearchOptions,
): SearchableField[] {
  const out: SearchableField[] = [];
  const role = msg.role;
  const roleLabel = role === "assistant" ? "assistant" : role === "user" ? "user" : "system";

  // 1. Top-level content (and structured blocks[], which carries the
  //    chronological text/tool interleaving). We index `content` plus any
  //    text blocks; tool blocks are indexed via toolUse below to avoid
  //    double-counting identical text.
  if (typeof msg.content === "string" && msg.content.length) {
    out.push({ messageIndex: index, field: "content", blockIndex: -1, label: roleLabel, text: msg.content });
  } else if (Array.isArray(msg.blocks)) {
    // No string content but blocks present (some messages only carry blocks).
    const textParts: string[] = [];
    for (const b of msg.blocks) {
      if (b.type === "text" && typeof b.content === "string") textParts.push(b.content);
    }
    if (textParts.length) {
      out.push({ messageIndex: index, field: "content", blockIndex: -1, label: roleLabel, text: textParts.join("\n") });
    }
  }

  // 2. Thinking / reasoning text (legacy field or chronological thinking blocks).
  const thinkingText =
    typeof msg.thinking === "string"
      ? msg.thinking
      : msg.blocks
          ?.filter((b) => b.type === "thinking")
          .map((b) => b.content || "")
          .join("\n") ?? "";
  if (opts.includeThinking !== false && thinkingText.length) {
    out.push({ messageIndex: index, field: "thinking", blockIndex: -1, label: "thinking", text: thinkingText });
  }

  // 3. Tool use blocks (input + output).
  if (opts.includeToolContent !== false && msg.toolUse && msg.toolUse.length) {
    msg.toolUse.forEach((tu: ToolUseBlock, bi: number) => {
      const name = tu.toolName || "tool";
      const inputText = toolInputText(tu.input, tu.argsJson);
      if (inputText.length) {
        out.push({ messageIndex: index, field: "toolInput", blockIndex: bi, label: `${name}`, text: inputText });
      }
      if (typeof tu.output === "string" && tu.output.length) {
        out.push({ messageIndex: index, field: "toolOutput", blockIndex: bi, label: `${name} (out)`, text: tu.output });
      }
    });
  }

  return out;
}

// ─── Matching ───────────────────────────────────────────────────────────────

interface CompiledQuery {
  /** Returns all non-overlapping match ranges for a given haystack. */
  findAll: (haystack: string) => HighlightRange[];
  /** Whether the query compiled successfully (regex mode may throw). */
  valid: boolean;
  /** Original query string (for re-render / persistence). */
  raw: string;
}

/** Compile a substring or regex query into a range finder. */
function compileQuery(query: string, opts: SearchOptions): CompiledQuery {
  const flags = opts.caseSensitive ? "g" : "gi";
  if (opts.regex) {
    try {
      const re = new RegExp(query, flags);
      return {
        raw: query,
        valid: true,
        findAll: (haystack: string): HighlightRange[] => {
          const ranges: HighlightRange[] = [];
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          let guard = 0;
          while ((m = re.exec(haystack)) !== null) {
            const start = m.index;
            const end = start + m[0].length;
            // Zero-width match (e.g. `a*`): advance to avoid an infinite loop.
            if (end === start) {
              re.lastIndex++;
              continue;
            }
            ranges.push({ start, end });
            if (++guard > 5000) break; // hard cap on pathological input
          }
          return ranges;
        },
      };
    } catch {
      return { raw: query, valid: false, findAll: () => [] };
    }
  }
  // Substring mode. Empty needle matches nothing (avoids highlighting all).
  if (!query) return { raw: query, valid: false, findAll: () => [] };
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  return {
    raw: query,
    valid: true,
    findAll: (haystack: string): HighlightRange[] => {
      if (!haystack) return [];
      const h = opts.caseSensitive ? haystack : haystack.toLowerCase();
      const ranges: HighlightRange[] = [];
      let from = 0;
      let guard = 0;
      while (guard < 5000) {
        const idx = h.indexOf(needle, from);
        if (idx < 0) break;
        ranges.push({ start: idx, end: idx + needle.length });
        from = idx + needle.length;
        guard++;
      }
      return ranges;
    },
  };
}

// ─── Scoring ────────────────────────────────────────────────────────────────
//
// Score components (additive, larger = better):
//   • field weight    — body text > thinking > tool input > tool output
//   • position bonus  — earlier first-match index is better
//   • density bonus   — more matches per 1k chars signals relevance
//   • length penalty  — very long noisy fields rank lower
//   • recency bonus   — later messages get a tiny boost (what you just saw)

const FIELD_WEIGHT: Record<SearchField, number> = {
  content: 100,
  thinking: 60,
  toolInput: 45,
  toolOutput: 20,
};

function scoreField(
  field: SearchField,
  fieldText: string,
  firstMatchIndex: number,
  matchCount: number,
  messageIndex: number,
  messageTotal: number,
): number {
  const base = FIELD_WEIGHT[field];
  const positionBonus = Math.max(0, 200 - firstMatchIndex) * 0.25;
  const density = matchCount / Math.max(1, fieldText.length / 1000) * 5;
  const lengthPenalty = fieldText.length > 4000 ? (fieldText.length - 4000) * 0.002 : 0;
  // Tiny recency nudge (0..~5) so ties break toward recent context.
  const recency = messageTotal > 0 ? (messageIndex / messageTotal) * 5 : 0;
  return base + positionBonus + density - lengthPenalty + recency;
}

// ─── Snippet ────────────────────────────────────────────────────────────────

/** Build a single-line snippet centered on the first highlight. */
function buildSnippet(
  fieldText: string,
  firstStart: number,
  firstEnd: number,
  radius: number,
): { snippet: string; snippetHighlightStart: number } {
  // Collapse newlines/tabs so the snippet fits one rendered line.
  const flat = fieldText.replace(/\s+/g, " ");
  const start = Math.max(0, firstStart - radius);
  const end = Math.min(flat.length, firstEnd + radius);
  let snippet = flat.slice(start, end).trimEnd();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  // snippetHighlightStart is relative to the trimmed snippet body.
  const leadingWhitespace = snippet.length - snippet.trimStart().length;
  let relStart = firstStart - start - leadingWhitespace;
  if (relStart < 0) relStart = 0;
  snippet = prefix + snippet.trimStart() + suffix;
  // Adjust for the ellipsis prefix we prepended.
  const snippetHighlightStart = prefix.length + relStart;
  return { snippet, snippetHighlightStart };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface SearchResult {
  /** Original query. */
  query: string;
  /** Whether the query compiled (false on bad regex). */
  valid: boolean;
  /** All matches, ranked best-first. */
  matches: SearchMatch[];
}

/**
 * Search a conversation for `query`, returning ranked matches with snippets
 * and highlight offsets for n/N navigation.
 *
 * Default mode is case-insensitive substring; pass `{ regex: true }` for
 * regex. Returns matches sorted by score (desc), then by message index
 * (asc) for stable ordering. An empty/invalid query yields no matches.
 */
export function searchMessages(
  messages: readonly Message[],
  query: string,
  opts: SearchOptions = {},
): SearchResult {
  const compiled = compileQuery(query, opts);
  if (!compiled.valid) {
    return { query, valid: false, matches: [] };
  }

  const limit = opts.limit ?? 200;
  const radius = opts.snippetRadius ?? 40;
  const total = messages.length;
  const matches: SearchMatch[] = [];

  for (let i = 0; i < messages.length; i++) {
    const fields = extractFields(messages[i]!, i, opts);
    for (const f of fields) {
      const ranges = compiled.findAll(f.text);
      if (!ranges.length) continue;
      const first = ranges[0]!;
      const score = scoreField(f.field, f.text, first.start, ranges.length, i, total);
      const { snippet, snippetHighlightStart } = buildSnippet(f.text, first.start, first.end, radius);
      matches.push({
        messageIndex: i,
        field: f.field,
        blockIndex: f.blockIndex,
        label: f.label,
        fieldText: f.text,
        highlights: ranges,
        snippet,
        snippetHighlightStart,
        score,
      });
    }
  }

  // Rank: score desc, then message index asc, then field order (stable).
  const fieldOrder: Record<SearchField, number> = { content: 0, thinking: 1, toolInput: 2, toolOutput: 3 };
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.messageIndex !== b.messageIndex) return a.messageIndex - b.messageIndex;
    return fieldOrder[a.field] - fieldOrder[b.field];
  });

  return { query, valid: true, matches: matches.slice(0, limit) };
}

// ─── n/N navigation helpers ─────────────────────────────────────────────────

/**
 * Given a flat ranked list and the current cursor, return the next index
 * (wrapping). Pass `direction = -1` for previous (N). Returns -1 when there
 * is nothing to navigate (empty results).
 */
export function nextMatchIndex(
  matchCount: number,
  currentIndex: number,
  direction: 1 | -1 = 1,
): number {
  if (matchCount <= 0) return -1;
  if (currentIndex < 0) return direction === 1 ? 0 : matchCount - 1;
  return (currentIndex + direction + matchCount) % matchCount;
}

/**
 * Convenience: pick the best match that lands on or after a given message
 * index — useful to "jump to next match in transcript order" when the user
 * is scrolled to a specific message rather than navigating the ranked list.
 */
export function findMatchAtOrAfterMessage(
  matches: readonly SearchMatch[],
  fromMessageIndex: number,
): number {
  // Matches are ranked, so find the lowest-ranked-position match whose
  // messageIndex >= fromMessageIndex; wrap to 0 otherwise.
  let bestPos = -1;
  let bestMsg = Infinity;
  let wrapPos = -1;
  let wrapMsg = Infinity;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    if (m.messageIndex >= fromMessageIndex) {
      if (m.messageIndex < bestMsg) {
        bestMsg = m.messageIndex;
        bestPos = i;
      }
    } else if (m.messageIndex < wrapMsg) {
      wrapMsg = m.messageIndex;
      wrapPos = i;
    }
  }
  return bestPos >= 0 ? bestPos : wrapPos;
}
