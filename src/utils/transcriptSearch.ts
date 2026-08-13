













import type { Message, MessageBlock, ToolUseBlock } from "../types/index.js";



export interface SearchOptions {
  
  regex?: boolean;
  
  caseSensitive?: boolean;
  
  includeThinking?: boolean;
  
  includeToolContent?: boolean;
  
  limit?: number;
  
  snippetRadius?: number;
}


export interface HighlightRange {
  
  start: number;
  
  end: number;
}


export type SearchField = "content" | "thinking" | "toolInput" | "toolOutput";

export interface SearchMatch {
  
  messageIndex: number;
  
  field: SearchField;
  
  blockIndex: number;
  
  label: string;
  
  fieldText: string;
  
  highlights: HighlightRange[];
  
  snippet: string;
  
  snippetHighlightStart: number;
  
  score: number;
}







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


function toolInputText(input: string | undefined, argsJson: string | undefined): string {
  
  
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


function extractFields(
  msg: Message,
  index: number,
  opts: SearchOptions,
): SearchableField[] {
  const out: SearchableField[] = [];
  const role = msg.role;
  const roleLabel = role === "assistant" ? "assistant" : role === "user" ? "user" : "system";

  
  
  
  
  if (typeof msg.content === "string" && msg.content.length) {
    out.push({ messageIndex: index, field: "content", blockIndex: -1, label: roleLabel, text: msg.content });
  } else if (Array.isArray(msg.blocks)) {
    
    const textParts: string[] = [];
    for (const b of msg.blocks) {
      if (b.type === "text" && typeof b.content === "string") textParts.push(b.content);
    }
    if (textParts.length) {
      out.push({ messageIndex: index, field: "content", blockIndex: -1, label: roleLabel, text: textParts.join("\n") });
    }
  }

  
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



interface CompiledQuery {
  
  findAll: (haystack: string) => HighlightRange[];
  
  valid: boolean;
  
  raw: string;
}


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
            
            if (end === start) {
              re.lastIndex++;
              continue;
            }
            ranges.push({ start, end });
            if (++guard > 5000) break; 
          }
          return ranges;
        },
      };
    } catch {
      return { raw: query, valid: false, findAll: () => [] };
    }
  }
  
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
  
  const recency = messageTotal > 0 ? (messageIndex / messageTotal) * 5 : 0;
  return base + positionBonus + density - lengthPenalty + recency;
}




function buildSnippet(
  fieldText: string,
  firstStart: number,
  firstEnd: number,
  radius: number,
): { snippet: string; snippetHighlightStart: number } {
  
  const flat = fieldText.replace(/\s+/g, " ");
  const start = Math.max(0, firstStart - radius);
  const end = Math.min(flat.length, firstEnd + radius);
  let snippet = flat.slice(start, end).trimEnd();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  
  const leadingWhitespace = snippet.length - snippet.trimStart().length;
  let relStart = firstStart - start - leadingWhitespace;
  if (relStart < 0) relStart = 0;
  snippet = prefix + snippet.trimStart() + suffix;
  
  const snippetHighlightStart = prefix.length + relStart;
  return { snippet, snippetHighlightStart };
}



export interface SearchResult {
  
  query: string;
  
  valid: boolean;
  
  matches: SearchMatch[];
}


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

  
  const fieldOrder: Record<SearchField, number> = { content: 0, thinking: 1, toolInput: 2, toolOutput: 3 };
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.messageIndex !== b.messageIndex) return a.messageIndex - b.messageIndex;
    return fieldOrder[a.field] - fieldOrder[b.field];
  });

  return { query, valid: true, matches: matches.slice(0, limit) };
}




export function nextMatchIndex(
  matchCount: number,
  currentIndex: number,
  direction: 1 | -1 = 1,
): number {
  if (matchCount <= 0) return -1;
  if (currentIndex < 0) return direction === 1 ? 0 : matchCount - 1;
  return (currentIndex + direction + matchCount) % matchCount;
}


export function findMatchAtOrAfterMessage(
  matches: readonly SearchMatch[],
  fromMessageIndex: number,
): number {
  
  
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
