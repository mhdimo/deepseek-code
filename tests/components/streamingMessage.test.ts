import { expect, test } from "bun:test";

import type { MessageBlock } from "../../src/types/index.js";
import { buildStreamingAssistantMessage } from "../../src/components/streamingMessage.js";

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
