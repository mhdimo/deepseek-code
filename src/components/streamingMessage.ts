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

/**
 * Finalize a turn the user cut short.
 *
 * The normal path drops every `running` block — correct for a turn the engine
 * completed, where still running means the result never arrived. Applied to an
 * interrupt that same rule erases the only evidence of what was underway: the
 * in-flight call is discarded with the aborted stream, and a tool cancelled
 * halfway is indistinguishable from one that was never requested.
 *
 * Here the running blocks are kept and marked `interrupted`, which the tool
 * block renderer has drawn all along (`✗ Edit (src/x.ts) [interrupted]`). Text
 * already streamed and settled tool results are carried over untouched.
 *
 * Blocks and the tool list wrap the *same* objects (see the `tool-call-start`
 * handler), so patching by identity keeps the two in step; a block whose tool
 * object is in neither list is patched on its own rather than dropped.
 */
export function interruptStreamingTurn(
  blocks: MessageBlock[],
  content: string,
  toolUse: ToolUseBlock[],
): Message | null {
  const replaced = new Map<ToolUseBlock, ToolUseBlock>();
  const nextToolUse = toolUse.map((tool) => {
    if (tool.status !== "running") return tool;
    const interrupted: ToolUseBlock = { ...tool, status: "interrupted" };
    replaced.set(tool, interrupted);
    return interrupted;
  });

  const nextBlocks = blocks.map((block): MessageBlock => {
    if (block.type !== "tool" || block.block?.status !== "running") return block;
    const shared = replaced.get(block.block);
    return {
      type: "tool",
      block: shared ?? { ...block.block, status: "interrupted" },
    };
  });

  return buildStreamingAssistantMessage(nextBlocks, content, nextToolUse);
}

/**
 * Cap a tool result for the retained transcript.
 *
 * Tool-level caps (Bash 50KB, fetch 50KB, the maxResultSizeChars enforcement)
 * bound single results, but a long session still holds every tool output in
 * React state forever. The renderer only ever shows ~200 lines anyway; /export
 * uses message content. Keep a generous head so transcripts stay usable
 * without unbounded RAM growth.
 */
export function capRetainedOutput(output: string, max: number): string {
  if (output.length <= max) return output;
  return (
    output.slice(0, max) +
    "\n\n... [retained output truncated at " +
    Math.floor(max / 1024) +
    "KB — full result was " +
    Math.ceil(output.length / 1024) +
    "KB]"
  );
}

/**
 * The engine's refusal payload — `{"error":"permission_denied","tool":…}`,
 * built by `ai::with_permissions`. It travels back as an ordinary tool
 * *output*: the wire carries no error flag on a tool result, so a refused
 * call would otherwise render as a tool that succeeded and printed some JSON.
 *
 * Anchored to the whole string, so a legitimate result that merely mentions
 * the marker cannot be read as a refusal.
 */
const PERMISSION_DENIAL =
  /^\s*\{\s*"error"\s*:\s*"permission_denied"\s*(?:,\s*"tool"\s*:\s*"(?:[^"\\]|\\.)*"\s*)?\}\s*$/;

export function isPermissionDenial(result: string): boolean {
  return PERMISSION_DENIAL.test(result);
}

export interface NativeToolResult {
  toolCallId: string;
  toolName: string;
  result: string;
}

export interface NativeToolResultUpdate {
  toolUse: ToolUseBlock[];
  blocks: MessageBlock[];
  /** False when the result belonged to no call we are still tracking — the
   *  caller skips its render flush on a no-op. */
  changed: boolean;
}

/**
 * Attach a result produced *inside the engine* to the block the stream opened
 * for that call.
 *
 * Tools the engine runs itself — every tool of an attached MCP server — never
 * reach the TS execute wrapper, so nothing calls `onToolResult` for them. The
 * only signal the TUI gets is the stream's `tool_result`, which carries the
 * call id. Without this the block stays `running` for the whole turn and is
 * then filtered out of the finalized message: the call is dropped from the
 * transcript and its output is never shown.
 *
 * The engine emits a `tool_result` for TS-registered tools too (their results
 * are fed back into its history). Those have already been finalized by
 * `handleToolResult` with more detail than the event carries, so only blocks
 * still `running` are touched.
 */
export function applyNativeToolResult(
  toolUse: ToolUseBlock[],
  blocks: MessageBlock[],
  event: NativeToolResult,
  maxOutput: number,
): NativeToolResultUpdate {
  const running = (b: ToolUseBlock): boolean => b.status === "running";
  const named = (b: ToolUseBlock): boolean => running(b) && b.toolName === event.toolName;

  // A call id, when the event carries one, is exclusive: several tools with
  // the same name can be in flight at once, and attaching a result to the
  // wrong one is worse than not attaching it. The only other block it may
  // settle is one that has no id of its own — nothing could disambiguate by id
  // there, so the earliest running match is the best answer available.
  let index = event.toolCallId
    ? toolUse.findIndex((b) => running(b) && b.toolCallId === event.toolCallId)
    : -1;
  if (index === -1) {
    index = event.toolCallId
      ? toolUse.findIndex((b) => named(b) && !b.toolCallId)
      : // No id at all (an older addon, or a start event that never arrived):
        // results arrive in step order, so first-running is the earliest
        // start — the one reporting.
        toolUse.findIndex(named);
  }
  if (index === -1) return { toolUse, blocks, changed: false };

  const previous = toolUse[index]!;
  const denied = isPermissionDenial(event.result);
  const updated: ToolUseBlock = {
    ...previous,
    status: denied ? "rejected" : "done",
    output: capRetainedOutput(event.result, maxOutput),
  };
  const nextToolUse = [...toolUse];
  nextToolUse[index] = updated;

  // The block list wraps the same object the tool list holds. Replacing only
  // the tool-list entry would leave the transcript rendering the stale
  // `running` block — and a running block is exactly what finalization drops.
  let blockIndex = blocks.findIndex((b) => b.type === "tool" && b.block === previous);
  if (blockIndex === -1 && event.toolCallId) {
    blockIndex = blocks.findIndex(
      (b) =>
        b.type === "tool" &&
        b.block?.status === "running" &&
        b.block.toolCallId === event.toolCallId,
    );
  }
  if (blockIndex === -1) return { toolUse: nextToolUse, blocks, changed: true };

  const nextBlocks = [...blocks];
  nextBlocks[blockIndex] = { type: "tool", block: updated };
  return { toolUse: nextToolUse, blocks: nextBlocks, changed: true };
}
