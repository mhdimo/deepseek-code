import type { Message, MessageBlock, ToolUseBlock } from "../types/index.js";

/**
 * Builds the in-flight assistant turn from the same ordered blocks that the
 * stream produced. Keeping this as one Message lets the transcript renderer
 * place thinking, text, and tools together instead of appending a second
 * footer below the transcript.
 */
export function buildStreamingAssistantMessage(
  blocks: MessageBlock[],
  content: string,
  toolUse: ToolUseBlock[],
): Message | null {
  if (blocks.length === 0 && !content && toolUse.length === 0) return null;

  return {
    role: "assistant",
    content,
    blocks: blocks.length > 0 ? [...blocks] : undefined,
    toolUse: toolUse.length > 0 ? [...toolUse] : undefined,
  };
}
