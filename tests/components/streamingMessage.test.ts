import { expect, test } from "bun:test";

import type { MessageBlock } from "../../src/types/index.js";
import {
  buildStreamingAssistantMessage,
  interruptStreamingTurn,
} from "../../src/components/streamingMessage.js";

test("keeps the live assistant blocks in stream order", () => {
  const blocks: MessageBlock[] = [
    { type: "thinking", content: "Inspecting the request" },
    { type: "text", content: "I found the relevant file." },
    {
      type: "tool",
      block: { toolName: "Read", input: "src/App.tsx", status: "done" },
    },
    { type: "text", content: "The rendering path is now clear." },
  ];

  const message = buildStreamingAssistantMessage(blocks, "", []);

  expect(message?.role).toBe("assistant");
  expect(message?.blocks?.map((block) => block.type)).toEqual([
    "thinking",
    "text",
    "tool",
    "text",
  ]);
});

test("uses text and tools as a fallback while blocks are not flushed", () => {
  const message = buildStreamingAssistantMessage([], "Still working", [
    { toolName: "Read", input: "src/App.tsx", status: "running" },
  ]);

  expect(message).toEqual({
    role: "assistant",
    content: "Still working",
    toolUse: [{ toolName: "Read", input: "src/App.tsx", status: "running" }],
  });
});

test("returns no live message before the first stream event", () => {
  expect(buildStreamingAssistantMessage([], "", [])).toBeNull();
});

test("marks the cancelled call interrupted instead of dropping the turn", () => {
  const running = {
    toolName: "Edit",
    input: "src/foo.ts",
    status: "running" as const,
    toolCallId: "call-1",
  };
  const settled = {
    toolName: "Read",
    input: "src/foo.ts",
    status: "done" as const,
    output: "…",
  };
  const blocks: MessageBlock[] = [
    { type: "text", content: "Editing now." },
    { type: "tool", block: settled },
    { type: "tool", block: running },
  ];

  const message = interruptStreamingTurn(blocks, "Editing now.", [settled, running]);

  expect(message?.content).toBe("Editing now.");
  expect(message?.toolUse?.map((tool) => tool.status)).toEqual(["done", "interrupted"]);
  // The engine can still be reporting on the call that was in flight when the
  // user pressed Esc — the id survives so its late result is not misattached.
  expect(message?.toolUse?.[1]?.toolCallId).toBe("call-1");
  expect(message?.blocks?.map((block) => block.type)).toEqual(["text", "tool", "tool"]);
  const interruptedBlock = message?.blocks?.[2];
  expect(interruptedBlock?.type === "tool" && interruptedBlock.block?.status).toBe("interrupted");
  // Block and tool list must stay the same object, or the transcript renders a
  // stale `running` block — exactly what finalization drops.
  expect(
    interruptedBlock?.type === "tool" ? interruptedBlock.block : null,
  ).toBe(message?.toolUse?.[1]);
});

test("interrupts a tool block that has no tool-list entry", () => {
  const orphan = {
    toolName: "Bash",
    input: "bun test",
    status: "running" as const,
  };
  const message = interruptStreamingTurn(
    [{ type: "tool", block: orphan }],
    "",
    [],
  );

  const block = message?.blocks?.[0];
  expect(block?.type === "tool" && block.block?.status).toBe("interrupted");
  // A fresh object: the caller's block list must not be mutated in place.
  expect(orphan.status).toBe("running");
});

test("interrupting an untouched stream yields no message", () => {
  expect(interruptStreamingTurn([], "", [])).toBeNull();
});
