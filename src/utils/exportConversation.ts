// exportConversation — export a conversation to Markdown or JSON
//
// Pure TS: consumes the Message type from types/index.ts and produces a
// readable string. Markdown renders roles, code blocks, thinking, and tool
// calls in a clean, reviewable form. JSON dumps a clean structured object.
//
// A writeToFile() helper is provided for the slash-command wiring to persist
// the export to disk. It prefers Bun.write (see CLAUDE.md Bun conventions)
// but falls back to fs/promises writeFile when Bun is unavailable.

import type { Message, MessageBlock, ToolUseBlock } from "../types/index.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ExportFormat = "markdown" | "json";

export interface ExportOptions {
  /** Include system messages in the export. Default: false. */
  includeSystem?: boolean;
  /** Include reasoning/thinking text. Default: true. */
  includeThinking?: boolean;
  /** Max chars of a tool call's output to include in the markdown summary. Default: 2000. */
  maxToolOutputChars?: number;
  /** Title used at the top of the markdown export. */
  title?: string;
}

export interface WriteResult {
  path: string;
  bytes: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

function truncate(text: string | undefined, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (${text.length - max} more chars truncated)`;
}

/** Wrap a chunk of text in a fenced code block, escaping any nested fences. */
function fencedCodeBlock(text: string, lang = ""): string {
  // Bump the fence width if the content contains a fence of the same length.
  let fenceLen = 3;
  const fenceRe = /(`{3,})/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) && m[1]) {
    fenceLen = Math.max(fenceLen, m[1].length + 1);
  }
  const fence = "`".repeat(fenceLen);
  return `${fence}${lang}\n${text}\n${fence}`;
}

function roleLabel(role: Message["role"]): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    default:
      return String(role);
  }
}

function parseToolInput(block: ToolUseBlock): Record<string, unknown> {
  // toolUse blocks may carry the args as a JSON string (input/argsJson) or
  // as already-parsed text. Try JSON first, fall back to the raw string.
  const raw = block.argsJson ?? block.input;
  if (!raw) return {};
  if (typeof raw !== "string") return raw as Record<string, unknown>;
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

/** Build a short, human-readable summary line of a tool call's arguments. */
function summarizeToolArgs(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      const short = val.length > 80 ? val.slice(0, 79) + "…" : val;
      return `${k}: ${short}`;
    })
    .join(", ");
}

function formatTimestamp(ts?: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toISOString();
  } catch {
    return "";
  }
}

// ─── Markdown rendering ─────────────────────────────────────────────────────

function renderToolUseMarkdown(
  block: ToolUseBlock,
  maxOutput: number,
): string {
  const name = block.toolName || "tool";
  const status = block.status ? ` [${block.status}]` : "";
  const argsInput = parseToolInput(block);
  const argSummary = summarizeToolArgs(argsInput);

  const lines: string[] = [];
  lines.push(`**Tool: \`${name}\`**${status}`);
  if (argSummary) lines.push(`> ${argSummary}`);
  if (block.duration !== undefined) {
    lines.push(`> _duration: ${(block.duration / 1000).toFixed(2)}s_`);
  }
  if (block.output) {
    const trimmed = truncate(block.output.trim(), maxOutput);
    lines.push(fencedCodeBlock(trimmed));
  }
  return lines.join("\n");
}

function renderMessageMarkdown(message: Message, opts: ExportOptions): string {
  const maxToolOutput = opts.maxToolOutputChars ?? 2000;
  const includeThinking = opts.includeThinking !== false;
  const ts = formatTimestamp(message.timestamp);
  const header = `## ${roleLabel(message.role)}${ts ? `  —  ${ts}` : ""}${
    message.isError ? "  (error)" : ""
  }`;

  const sections: string[] = [header];

  // Prefer the chronological `blocks` layout when present (text + tool calls
  // interleaved). Otherwise fall back to content + toolUse.
  if (message.blocks && message.blocks.length > 0) {
    for (const block of message.blocks) {
      if (block.type === "text" && block.content) {
        sections.push(block.content);
      } else if (block.type === "tool" && block.block) {
        sections.push(renderToolUseMarkdown(block.block, maxToolOutput));
      }
    }
  } else {
    if (message.content) {
      sections.push(message.content);
    }
    if (message.toolUse && message.toolUse.length > 0) {
      for (const toolBlock of message.toolUse) {
        sections.push(renderToolUseMarkdown(toolBlock, maxToolOutput));
      }
    }
  }

  const thinkingText =
    message.thinking ??
    message.blocks
      ?.filter((b) => b.type === "thinking")
      .map((b) => b.content || "")
      .join("\n\n");
  if (includeThinking && thinkingText) {
    sections.push(
      `<details><summary>Reasoning</summary>\n\n${fencedCodeBlock(
        thinkingText.trim(),
      )}\n\n</details>`,
    );
  }

  return sections.filter((s) => s.length > 0).join("\n\n");
}

function renderMarkdown(messages: Message[], opts: ExportOptions): string {
  const title = opts.title ?? "Conversation Export";
  const now = new Date().toISOString();
  const parts: string[] = [
    `# ${title}`,
    "",
    `_Exported: ${now}  ·  ${messages.length} message(s)_`,
    "",
    "---",
    "",
  ];
  for (const msg of messages) {
    parts.push(renderMessageMarkdown(msg, opts));
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  return parts.join("\n");
}

// ─── JSON rendering ─────────────────────────────────────────────────────────

function toolUseToJson(block: ToolUseBlock): Record<string, unknown> {
  return {
    toolName: block.toolName,
    toolCallId: block.toolCallId ?? null,
    args: parseToolInput(block),
    status: block.status ?? null,
    durationMs: block.duration ?? null,
    output: block.output ?? null,
  };
}

function messageToJson(
  message: Message,
  opts: ExportOptions,
): Record<string, unknown> {
  const blocks: unknown[] = [];
  if (message.blocks && message.blocks.length > 0) {
    for (const block of message.blocks) {
      if (block.type === "text") {
        blocks.push({ type: "text", content: block.content ?? "" });
      } else if (block.type === "tool" && block.block) {
        blocks.push({ type: "tool", tool: toolUseToJson(block.block) });
      }
    }
  } else {
    if (message.content) {
      blocks.push({ type: "text", content: message.content });
    }
    if (message.toolUse) {
      for (const tb of message.toolUse) {
        blocks.push({ type: "tool", tool: toolUseToJson(tb) });
      }
    }
  }

  const includeThinking = opts.includeThinking !== false;
  const obj: Record<string, unknown> = {
    role: message.role,
    timestamp: message.timestamp ?? null,
    isoTime: formatTimestamp(message.timestamp) || null,
    isError: message.isError === true,
    blocks,
  };
  if (includeThinking && message.thinking) {
    obj.thinking = message.thinking;
  }
  return obj;
}

function renderJson(messages: Message[], opts: ExportOptions): string {
  const payload = {
    title: opts.title ?? "conversation",
    exportedAt: new Date().toISOString(),
    format: "deepseek-code-export-v1",
    messageCount: messages.length,
    messages: messages.map((m) => messageToJson(m, opts)),
  };
  return JSON.stringify(payload, null, 2);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Serialize a conversation (array of Messages) to a string.
 *
 * @param messages  The conversation messages to export.
 * @param format    "markdown" for a readable transcript, "json" for a
 *                  structured dump.
 * @param opts      Optional flags (see ExportOptions).
 */
export function exportMessages(
  messages: readonly Message[],
  format: ExportFormat,
  opts: ExportOptions = {},
): string {
  const filtered = opts.includeSystem
    ? [...messages]
    : messages.filter((m) => m.role !== "system");

  if (format === "json") {
    return renderJson(filtered, opts);
  }
  return renderMarkdown(filtered, opts);
}

/**
 * Export messages and write the result to a file.
 *
 * Prefers Bun.write when available; falls back to fs/promises writeFile.
 * Returns the absolute path written and the byte count.
 */
export async function writeToFile(
  messages: readonly Message[],
  format: ExportFormat,
  path: string,
  opts: ExportOptions = {},
): Promise<WriteResult> {
  const content = exportMessages(messages, format, opts);
  const bytes = Buffer.byteLength(content, "utf-8");

  // Prefer Bun's fast write path (see CLAUDE.md Bun conventions).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BunRef: any = (globalThis as { Bun?: any }).Bun;
  if (BunRef && typeof BunRef.write === "function") {
    await BunRef.write(path, content);
  } else {
    const { writeFile } = await import("fs/promises");
    await writeFile(path, content, "utf-8");
  }

  return { path, bytes };
}
