// Context manager — token counting, auto-compaction, and message trimming
//
// Responsibilities:
//   - Estimate token counts for messages (rough heuristic: 1 token ≈ 4 chars)
//   - Auto-compact when approaching model context limits
//   - Preserve recent messages and system prompt
//   - Aggressively summarize older tool results
//   - Track compaction boundary for message slicing

import type { Message, TokenBudget } from "../types/index.js";

// ─── Token estimation ───────────────────────────────────────────────────────

/** Rough token estimate: 1 token ≈ 4 characters for English/code text */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate total tokens for a message */
function estimateMessageTokens(msg: Message): number {
  let tokens = estimateTokens(msg.content);
  if (msg.thinking) tokens += estimateTokens(msg.thinking);
  if (msg.toolUse) {
    for (const tool of msg.toolUse) {
      if (tool.input) tokens += estimateTokens(tool.input);
      if (tool.output) tokens += Math.min(estimateTokens(tool.output), 500); // cap tool output
    }
  }
  return tokens;
}

// ─── Default budgets per model ──────────────────────────────────────────────

export const DEFAULT_BUDGETS: Record<string, TokenBudget> = {
  "deepseek-chat": {
    maxContextTokens: 64_000,
    compactionThreshold: 0.8,
    reservedForResponse: 4096,
  },
  "deepseek-reasoner": {
    maxContextTokens: 64_000,
    compactionThreshold: 0.8,
    reservedForResponse: 8192,
  },
};

const FALLBACK_BUDGET: TokenBudget = {
  maxContextTokens: 64_000,
  compactionThreshold: 0.8,
  reservedForResponse: 4096,
};

// ─── ContextManager class ───────────────────────────────────────────────────

export class ContextManager {
  private budget: TokenBudget;
  private model: string;

  /** Index of the message that starts the "compacted summary" — everything before this was summarized */
  private compactionBoundary = 0;

  constructor(model: string, budget?: TokenBudget) {
    this.model = model;
    this.budget = budget ?? DEFAULT_BUDGETS[model] ?? FALLBACK_BUDGET;
  }

  /** Update model (e.g. after /model switch) */
  setModel(model: string): void {
    this.model = model;
    this.budget = DEFAULT_BUDGETS[model] ?? FALLBACK_BUDGET;
  }

  /** Get the current budget */
  getBudget(): TokenBudget {
    return this.budget;
  }

  /** Estimate total tokens used by a set of messages */
  estimateMessagesTokens(messages: Message[]): number {
    return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  }

  /** Check if the message history needs compaction */
  needsCompaction(messages: Message[]): boolean {
    const usedTokens = this.estimateMessagesTokens(messages);
    const limit = this.budget.maxContextTokens - this.budget.reservedForResponse;
    return usedTokens > limit * this.budget.compactionThreshold;
  }

  /**
   * Compact message history by:
   *   1. Keeping the system prompt (if any)
   *   2. Keeping the last N messages intact
   *   3. Summarizing older messages into a single system message
   *
   * Returns the compacted messages and compaction stats.
   */
  compact(messages: Message[], keepRecent = 6): {
    messages: Message[];
    before: number;
    after: number;
  } {
    if (messages.length <= keepRecent + 1) {
      return { messages, before: messages.length, after: messages.length };
    }

    // Separate system messages at the start
    const systemMessages = messages.filter((m) => m.role === "system" && messages.indexOf(m) < 3);
    const nonSystemMessages = messages.filter((m) => m.role !== "system" || messages.indexOf(m) >= 3);

    // Split into old (to summarize) and recent (to keep)
    const splitIdx = Math.max(0, nonSystemMessages.length - keepRecent);
    const oldMessages = nonSystemMessages.slice(0, splitIdx);
    const recentMessages = nonSystemMessages.slice(splitIdx);

    if (oldMessages.length === 0) {
      return { messages, before: messages.length, after: messages.length };
    }

    // Build summary of old messages
    const userTopics = oldMessages
      .filter((m) => m.role === "user")
      .map((m) => m.content.slice(0, 80))
      .filter(Boolean);

    const toolNames = oldMessages
      .filter((m) => m.toolUse?.length)
      .flatMap((m) => m.toolUse!.map((t) => t.toolName));

    const summaryParts: string[] = [
      `[Context compacted: ${oldMessages.length} older messages summarized]`,
    ];
    if (userTopics.length > 0) {
      summaryParts.push(`Topics discussed: ${userTopics.join(", ")}`);
    }
    if (toolNames.length > 0) {
      const unique = [...new Set(toolNames)];
      summaryParts.push(`Tools used: ${unique.join(", ")}`);
    }

    const summaryMessage: Message = {
      role: "system",
      content: summaryParts.join("\n"),
      timestamp: Date.now(),
    };

    this.compactionBoundary = systemMessages.length + 1; // after summary

    const compacted = [...systemMessages, summaryMessage, ...recentMessages];

    return {
      messages: compacted,
      before: messages.length,
      after: compacted.length,
    };
  }

  /**
   * Truncate tool output in messages to keep context lean.
   * Tool outputs can be very large (e.g. file reads) — truncate to maxChars.
   */
  truncateToolOutputs(messages: Message[], maxChars = 4000): Message[] {
    return messages.map((msg) => {
      if (!msg.toolUse?.length) return msg;

      return {
        ...msg,
        toolUse: msg.toolUse.map((tool) => {
          if (!tool.output || tool.output.length <= maxChars) return tool;
          return {
            ...tool,
            output: tool.output.slice(0, maxChars) + `\n… (${tool.output.length - maxChars} more chars)`,
          };
        }),
      };
    });
  }

  /**
   * Prepare messages for an API call:
   *   1. Truncate tool outputs
   *   2. Take last N messages to fit budget
   *   3. Filter out empty messages
   */
  prepareForAPI(messages: Message[], maxMessages = 30): Message[] {
    let prepared = this.truncateToolOutputs(messages);
    prepared = prepared.filter((m) => m.content.trim() || m.toolUse?.length);

    // Take the most recent messages
    if (prepared.length > maxMessages) {
      prepared = prepared.slice(-maxMessages);
    }

    return prepared;
  }
}
