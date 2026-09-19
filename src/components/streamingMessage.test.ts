/**
 * A tool the engine ran must land in the transcript.
 *
 * Tools of an attached MCP server execute inside the C++ engine, so nothing on
 * the TS side ever calls `onToolResult` for them — the stream's `tool_result`
 * event is the only account of what they returned, and the TUI consumed it
 * into nothing (`case "tool-call-result": break;`). The visible effect was a
 * tool that blinked for a whole turn and then disappeared: finalization drops
 * every block still marked `running`, so neither the call nor its output was
 * recorded anywhere.
 *
 * These tests pin the matching (by call id, since several tools can be in
 * flight at once) and the two things that must not happen: clobbering a result
 * the TS path already finalized, and losing a call whose id never arrived.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { MessageBlock, ToolUseBlock } from "../types/index.js";
import {
  applyNativeToolResult,
  capRetainedOutput,
  isPermissionDenial,
} from "./streamingMessage.js";

const MAX = 200_000;

/** The state the stream leaves behind: one running block in both lists,
 *  sharing the same object, exactly as `tool-call-start` builds it. */
function opened(block: ToolUseBlock): { toolUse: ToolUseBlock[]; blocks: MessageBlock[] } {
  return { toolUse: [block], blocks: [{ type: "tool", block }] };
}

function running(toolName: string, toolCallId: string): ToolUseBlock {
  return { toolName, toolCallId, input: "", argsJson: "", status: "running" };
}

describe("a result from a tool the engine ran", () => {
  test("fills in the block the stream opened, and keeps the call", () => {
    const block = running("mcp__github__create_issue", "call_1");
    const { toolUse, blocks } = opened(block);

    const update = applyNativeToolResult(toolUse, blocks, {
      toolCallId: "call_1",
      toolName: "mcp__github__create_issue",
      result: "Created issue #7",
    }, MAX);

    expect(update.changed).toBe(true);
    expect(update.toolUse[0]?.status).toBe("done");
    expect(update.toolUse[0]?.output).toBe("Created issue #7");
    // The block list is what the transcript renders and what finalization
    // keeps: a stale `running` wrapper here is the dropped call.
    expect(update.blocks[0]?.block?.status).toBe("done");
    expect(update.blocks[0]?.block?.output).toBe("Created issue #7");
  });

  test("two calls in flight keep their own results", () => {
    // Same tool name, same turn: only the call id tells them apart.
    const first = running("mcp__fs__read", "call_a");
    const second = running("mcp__fs__read", "call_b");
    const toolUse = [first, second];
    const blocks: MessageBlock[] = [
      { type: "tool", block: first },
      { type: "tool", block: second },
    ];

    // Out of order, which is the point: the id decides, not arrival.
    const afterSecond = applyNativeToolResult(toolUse, blocks, {
      toolCallId: "call_b",
      toolName: "mcp__fs__read",
      result: "second file",
    }, MAX);
    const afterFirst = applyNativeToolResult(afterSecond.toolUse, afterSecond.blocks, {
      toolCallId: "call_a",
      toolName: "mcp__fs__read",
      result: "first file",
    }, MAX);

    expect(afterFirst.toolUse[0]?.output).toBe("first file");
    expect(afterFirst.toolUse[1]?.output).toBe("second file");
    expect(afterFirst.blocks[0]?.block?.output).toBe("first file");
    expect(afterFirst.blocks[1]?.block?.output).toBe("second file");
  });

  test("a result with no id falls back to the call still running", () => {
    const block = running("mcp__github__create_issue", "");
    const { toolUse, blocks } = opened(block);

    const update = applyNativeToolResult(toolUse, blocks, {
      toolCallId: "",
      toolName: "mcp__github__create_issue",
      result: "done",
    }, MAX);

    expect(update.toolUse[0]?.status).toBe("done");
    expect(update.blocks[0]?.block?.status).toBe("done");
  });

  test("a result for no known call changes nothing", () => {
    // A second call under the same name is still running. The orphan belongs
    // to neither, and guessing would hand one call another's output.
    const block = running("Bash", "call_1");
    const { toolUse, blocks } = opened(block);

    const update = applyNativeToolResult(toolUse, blocks, {
      toolCallId: "call_zzz",
      toolName: "Bash",
      result: "orphan",
    }, MAX);

    expect(update.changed).toBe(false);
    // Same arrays: the caller uses `changed` to skip a pointless re-render.
    expect(update.toolUse).toBe(toolUse);
    expect(update.blocks).toBe(blocks);
    expect(block.status).toBe("running");
  });

  test("a call the TS path already finished is left alone", () => {
    // The engine emits `tool_result` for TS-registered tools too (their result
    // goes back into its history), so this event arrives *after*
    // handleToolResult has set the real outcome. Overwriting it would lose the
    // error flag and the expansion, and re-render a finished tool.
    const finished: ToolUseBlock = {
      toolName: "Bash",
      toolCallId: "call_1",
      status: "error",
      output: "exit code 1",
      isExpanded: true,
    };
    const { toolUse, blocks } = { toolUse: [finished], blocks: [{ type: "tool", block: finished } as MessageBlock] };

    const update = applyNativeToolResult(toolUse, blocks, {
      toolCallId: "call_1",
      toolName: "Bash",
      result: "exit code 1",
    }, MAX);

    expect(update.changed).toBe(false);
    expect(update.toolUse[0]).toBe(finished);
    expect(update.toolUse[0]?.status).toBe("error");
    expect(update.toolUse[0]?.isExpanded).toBe(true);
  });

  test("an oversized result is capped for the retained transcript", () => {
    const block = running("mcp__big__dump", "call_1");
    const { toolUse, blocks } = opened(block);
    const huge = "x".repeat(MAX) + "TAIL_MARKER";

    const update = applyNativeToolResult(toolUse, blocks, {
      toolCallId: "call_1",
      toolName: "mcp__big__dump",
      result: huge,
    }, MAX);

    // The head is kept and the overflow is replaced by a note — the note
    // itself rides along at the end, as it does for TS tools.
    const output = update.toolUse[0]?.output ?? "";
    expect(output.startsWith("x".repeat(MAX))).toBe(true);
    expect(output).not.toContain("TAIL_MARKER");
    expect(output).toContain("retained output truncated at 195KB");
    expect(output).toContain(`full result was ${Math.ceil(huge.length / 1024)}KB`);
  });
});

describe("a call the engine refused", () => {
  test("is marked rejected, not finished", () => {
    const block = running("mcp__github__delete_repo", "call_1");
    const { toolUse, blocks } = opened(block);

    const update = applyNativeToolResult(toolUse, blocks, {
      toolCallId: "call_1",
      toolName: "mcp__github__delete_repo",
      // What `ai::with_permissions` returns for a Deny.
      result: '{"error":"permission_denied","tool":"mcp__github__delete_repo"}',
    }, MAX);

    expect(update.toolUse[0]?.status).toBe("rejected");
    expect(update.blocks[0]?.block?.status).toBe("rejected");
  });

  test("only the engine's own payload counts as one", () => {
    expect(isPermissionDenial('{"error":"permission_denied","tool":"Bash"}')).toBe(true);
    expect(isPermissionDenial(' {"error": "permission_denied"} ')).toBe(true);

    // A tool's own output that merely mentions the marker is not a refusal —
    // these arrive as results often enough to matter (a grepped log, a test
    // report, a JSON API response about permissions).
    expect(isPermissionDenial('{"error":"not_found"}')).toBe(false);
    expect(isPermissionDenial('{"error":"permission_denied","tool":"x"} trailing')).toBe(false);
    expect(isPermissionDenial('the response was {"error":"permission_denied"}')).toBe(false);
    expect(isPermissionDenial("")).toBe(false);
  });
});

/**
 * The helper above is only half of the fix: the other half is the stream arm
 * that calls it. That arm sat as `case "tool-call-result": break;` — an event
 * consumed into nothing — for long enough that five audit agents read it as
 * the app having no handler at all, so this reads the source rather than
 * rendering it. App.tsx cannot be mounted without an Ink screen and a native
 * engine, and "the handler body is empty again" is exactly the regression.
 */
describe("the stream arm that applies a native result", () => {
  test("still calls the helper and updates both lists", () => {
    const source = readFileSync(join(import.meta.dir, "App.tsx"), "utf8");
    const start = source.indexOf('case "tool-call-result":');
    expect(start).toBeGreaterThan(-1);
    const arm = source.slice(start, source.indexOf('case "', start + 10));

    expect(arm).toContain("applyNativeToolResult(");
    // The tool list and the block list are separate state. Updating only one
    // leaves the transcript rendering the stale `running` block — which is the
    // block finalization drops, so the call would vanish again.
    expect(arm).toContain("streamingToolUseRef.current = update.toolUse");
    expect(arm).toContain("streamingBlocksRef.current = update.blocks");
    // …and the result has to reach the screen before the turn ends.
    expect(arm).toContain("scheduleStreamingFlush()");
  });
});

describe("capRetainedOutput", () => {
  test("leaves a result that fits untouched", () => {
    expect(capRetainedOutput("hello", MAX)).toBe("hello");
    expect(capRetainedOutput("x".repeat(MAX), MAX)).toBe("x".repeat(MAX));
  });

  test("says how much was dropped and how big the result was", () => {
    const capped = capRetainedOutput("y".repeat(3000), 1024);
    expect(capped.slice(0, 1024)).toBe("y".repeat(1024));
    expect(capped).toContain("retained output truncated at 1KB");
    expect(capped).toContain("full result was 3KB");
  });
});
