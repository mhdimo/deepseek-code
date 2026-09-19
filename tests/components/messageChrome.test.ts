import { expect, test } from "bun:test";
import { EventEmitter } from "events";
import React from "react";
import { Box, render } from "ink";
import chalk from "chalk";

import MessageView, { assistantLayout } from "../../src/components/MessageView.js";
// The transcript's bullet is platform-dependent — constants/figures.ts draws
// `⏺` on macOS and `●` everywhere else — so the assertions below interpolate
// it rather than spelling one of the two.
import { BLACK_CIRCLE } from "../../src/components/ToolBlock.js";
import ChatPanel, {
  countUnseenAssistantTurns,
  newMessagesPillLabel,
  stickyPromptFor,
  stickyPromptText,
  type ChatPanelHandle,
} from "../../src/components/ChatPanel.js";
import type { Message, MessageBlock, ToolUseBlock } from "../../src/types/index.js";

// Ink reaches colours through chalk, and the test process has no TTY — chalk
// would hand back plain text and a background assertion would pass vacuously.
// Raise the level so the frames carry the SGR codes a user's terminal sees.
chalk.level = 3;

/** Dark theme tokens the assertions below name. */
const USER_MESSAGE_BG = "\u001b[48;2;55;55;55m";
const SUBTLE_FG = "\u001b[38;2;80;80;80m";
const BRAND_BLUE_FG = "\u001b[38;2;77;107;254m";

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

function fakeStdout(): { stream: NodeJS.WriteStream; dump: () => string } {
  let out = "";
  const stream = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 60,
    isTTY: true,
    write: (chunk: string) => {
      out += chunk;
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  return { stream, dump: () => out };
}

const fakeStdin = (): NodeJS.ReadStream =>
  Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as NodeJS.ReadStream;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Renders `node`, runs `act`, and returns every frame plus just the frames
 *  the action wrote — the second is what proves a scrolled-up overlay
 *  appeared, since the first frame still carries the pre-scroll screen.
 *
 *  Ink runs in debug mode, so each write is a COMPLETE screen rather than a
 *  line diff: the diff stream is a terminal edit script whose changed slice
 *  alone gets written, which makes "this text is absent" unreadable. `act`
 *  gets a snapshot() to bracket the action and read back one whole frame. */
async function withInk(
  node: React.ReactElement,
  act: (snapshot: () => string) => Promise<void>,
): Promise<{ raw: string; after: string }> {
  const { stream, dump } = fakeStdout();
  const { unmount, cleanup } = render(node, {
    stdout: stream,
    stdin: fakeStdin(),
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });
  await sleep(80);
  const before = dump();
  await act(dump);
  await sleep(80);
  const raw = dump();
  unmount();
  cleanup();
  return { raw, after: raw.slice(before.length) };
}

async function renderMessage(
  message: Message,
  options: { isTranscriptMode?: boolean; isStreaming?: boolean } = {},
): Promise<{ raw: string; plain: string }> {
  const { raw } = await withInk(
    React.createElement(
      Box,
      { flexDirection: "column", width: 80 },
      React.createElement(MessageView, {
        message,
        contentWidth: 80,
        messageStartRow: 0,
        blockKeyBase: "m",
        onBlockReport: () => {},
        isTranscriptMode: options.isTranscriptMode ?? false,
        isStreaming: options.isStreaming ?? false,
      }),
    ),
    async () => {},
  );
  return { raw, plain: raw.replace(ANSI, "") };
}

const userMessage = (content: string): Message => ({ role: "user", content, timestamp: 1 });

const assistant = (blocks: MessageBlock[]): Message => ({
  role: "assistant",
  content: "",
  timestamp: 2,
  blocks,
});

/* ---------- the compact-summary row ---------- */

const compactionMessage: Message = {
  role: "user",
  content:
    "[Context compacted: the 12 messages above were summarized below.]\n\n## Goal\nMake the tests pass.\n## State\nDone.",
  compaction: { summarized: 12 },
  timestamp: 3,
};

test("a compaction summary collapses to the reference's one-line label", async () => {
  const { plain } = await renderMessage(compactionMessage);
  // CompactSummary.tsx:92 — dot, bold "Compact summary", dim ctrl+o hint.
  expect(plain).toContain(`${BLACK_CIRCLE} Compact summary (ctrl+o to expand)`);
  // The body is transcript-mode only (CompactSummary.tsx:100); before the fix
  // the whole generated summary was dumped here as a warning-coloured row.
  expect(plain).not.toContain("## Goal");
  expect(plain).not.toContain("⛝");
});

test("transcript mode prints the summary body behind the response gutter", async () => {
  const { plain } = await renderMessage(compactionMessage, { isTranscriptMode: true });
  expect(plain).toContain("Compact summary");
  expect(plain).not.toContain("ctrl+o to expand");
  expect(plain).toContain("⎿");
  expect(plain).toContain("## Goal");
});

/* ---------- head-row accounting ---------- */

test("a multi-line shell subject is reported as the rows it actually draws", async () => {
  // ToolBlock draws one head row per line of a Bash subject, and ChatPanel
  // places every later block by summing MessageView's reported rowCounts, so
  // the head span has to carry the measured height rather than a hard 1.
  const reports = new Map<string, { key: string; rowCount: number }[]>();
  const bash = { status: "done", toolName: "Bash", input: { command: "one\ntwo" }, output: "hi" };
  const { stream } = fakeStdout();
  const { unmount, cleanup } = render(
    React.createElement(
      Box,
      { flexDirection: "column", width: 80 },
      React.createElement(MessageView, {
        message: assistant([{ type: "tool", block: bash as unknown as ToolUseBlock }]),
        contentWidth: 80,
        messageStartRow: 0,
        blockKeyBase: "m",
        onBlockReport: (key: string, reps: { key: string; rowCount: number }[]) =>
          reports.set(key, reps.map((r) => ({ ...r }))),
      }),
    ),
    { stdout: stream, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false },
  );
  await sleep(80);
  unmount();
  cleanup();

  const spans = reports.get("m")!;
  expect(spans.find((s) => s.key === "m:b0:tool:head")!.rowCount).toBe(2);
  // The block's leading spacer, both head rows, and the folded result line.
  expect(spans.reduce((n, s) => n + s.rowCount, 0)).toBe(1 + 2 + 1);
});

/* ---------- per-block blank rows ---------- */

test("assistantLayout gives every unit its own leading blank row", () => {
  const layout = assistantLayout(
    assistant([
      { type: "text", content: "Alpha." },
      { type: "tool", block: { toolName: "Read", input: "a.ts", status: "done" } },
      { type: "text", content: "Omega." },
    ]),
  );
  expect(layout.map((unit) => unit.kind)).toEqual([
    "spacer",
    "block",
    "spacer",
    "block",
    "spacer",
    "block",
  ]);
  const spacerTags = layout.filter((unit) => unit.kind === "spacer").map((unit) => unit.tag);
  // One per unit, so the message no longer collapses to a single top margin.
  expect(spacerTags).toHaveLength(3);
  expect(new Set(spacerTags).size).toBe(3);
});

test("a run of Agent calls collapses to one unit, one blank row", () => {
  const layout = assistantLayout(
    assistant([
      { type: "tool", block: { toolName: "Agent", input: "a", status: "running" } },
      { type: "tool", block: { toolName: "Agent", input: "b", status: "running" } },
    ]),
  );
  expect(layout.map((unit) => unit.kind)).toEqual(["spacer", "fanout"]);
});

test("legacy content and every legacy tool call get their own blank row", () => {
  const layout = assistantLayout({
    role: "assistant",
    content: "Legacy text.",
    timestamp: 4,
    toolUse: [
      { toolName: "Read", input: "a.ts", status: "done" },
      { toolName: "Bash", input: "ls", status: "done" },
    ],
  });
  expect(layout.map((unit) => unit.kind)).toEqual([
    "spacer",
    "legacy-text",
    "spacer",
    "legacy-tool",
    "spacer",
    "legacy-tool",
  ]);
});

test("legacy thinking stays ahead of the blocks, with its own blank row", () => {
  const layout = assistantLayout({
    role: "assistant",
    content: "",
    thinking: "mulling it over",
    timestamp: 5,
    blocks: [{ type: "text", content: "Answer." }],
  });
  expect(layout.map((unit) => unit.kind)).toEqual(["spacer", "thinking", "spacer", "block"]);
});

test("consecutive text blocks are separated by a blank row on screen", async () => {
  const { plain } = await renderMessage(
    assistant([
      { type: "text", content: "Alpha paragraph." },
      { type: "text", content: "Beta paragraph." },
    ]),
  );
  expect(plain).toContain(`Alpha paragraph.\n\n${BLACK_CIRCLE} Beta paragraph.`);
});

/* ---------- the user prompt band ---------- */

test("the user prompt sits on the message background with a subtle pointer", async () => {
  const { raw } = await renderMessage(userMessage("do the thing"));
  expect(raw).toContain(USER_MESSAGE_BG);
  expect(raw).toContain(`${SUBTLE_FG}❯ `);
  // The pointer used to be bold brand blue; the reference's is plain subtle.
  expect(raw).not.toContain(BRAND_BLUE_FG);
  expect(raw).not.toContain("\u001b[1m❯");
});

/* ---------- streaming ---------- */

test("a streaming text block prints no block cursor", async () => {
  const { plain } = await renderMessage(
    assistant([{ type: "text", content: "Still writing this out" }]),
    { isStreaming: true },
  );
  expect(plain).toContain(`${BLACK_CIRCLE} Still writing this out`);
  expect(plain).not.toContain("▊");
});

/* ---------- scrolled-up chrome ---------- */

test("the pill reads Jump to bottom until new turns arrive", () => {
  expect(newMessagesPillLabel(0)).toBe("Jump to bottom");
  expect(newMessagesPillLabel(1)).toBe("1 new message");
  expect(newMessagesPillLabel(3)).toBe("3 new messages");
});

test("unseen counting folds each turn's entries into one message", () => {
  const messages: Message[] = [
    userMessage("first prompt"),
    // Tool-use-only entries are not what a user reads as a new message.
    assistant([{ type: "tool", block: { toolName: "Read", input: "a.ts", status: "done" } }]),
    assistant([{ type: "text", content: "Here is the answer." }]),
    userMessage("second prompt"),
    assistant([{ type: "text", content: "And another." }]),
  ];
  expect(countUnseenAssistantTurns(messages, 0)).toBe(2);
  expect(countUnseenAssistantTurns(messages, 3)).toBe(1);
  expect(countUnseenAssistantTurns(messages, messages.length)).toBe(0);
});

test("a prompt only earns a sticky header once its pointer has scrolled off", () => {
  const entries = [
    { text: "first prompt", startRow: 0 },
    { text: "second prompt", startRow: 8 },
  ];
  expect(stickyPromptFor(entries, 0)).toBeNull();
  // First prompt's "❯" is on row 1: still on screen at scrollTop 1.
  expect(stickyPromptFor(entries, 1)).toBeNull();
  expect(stickyPromptFor(entries, 2)).toBe("first prompt");
  expect(stickyPromptFor(entries, 9)).toBe("first prompt");
  // Second prompt's "❯" is on row 9.
  expect(stickyPromptFor(entries, 10)).toBe("second prompt");
});

test("only a typed prompt feeds the sticky header", () => {
  expect(stickyPromptText(userMessage("fix the bug"))).toBe("fix the bug");
  expect(stickyPromptText(compactionMessage)).toBeNull();
  expect(stickyPromptText(assistant([{ type: "text", content: "hi" }]))).toBeNull();
  expect(stickyPromptText(userMessage("   "))).toBeNull();
});

async function renderPanel(
  messages: Message[],
  act: (handle: ChatPanelHandle, snapshot: () => string) => void | Promise<void>,
): Promise<{ plain: string; after: string }> {
  const panelRef = React.createRef<ChatPanelHandle>();
  const { raw, after } = await withInk(
    React.createElement(
      Box,
      { flexDirection: "column", width: 80, height: 12 },
      React.createElement(ChatPanel, {
        ref: panelRef,
        messages,
        isLoading: false,
        streamingText: "",
        streamingToolUse: [],
        version: "0",
        model: "deepseek-chat",
        workingDirectory: "/tmp",
        agentName: "code",
        providerType: "deepseek",
      }),
    ),
    async (snapshot) => {
      await act(panelRef.current!, snapshot);
      await sleep(60);
    },
  );
  return { plain: raw.replace(ANSI, ""), after: after.replace(ANSI, "") };
}

/** The single frame the given action ends on — a whole screen, so what it does
 *  NOT contain is as meaningful as what it does. */
async function frameAfter(
  messages: Message[],
  act: (handle: ChatPanelHandle) => void,
): Promise<string> {
  let frame = "";
  await renderPanel(messages, async (handle, snapshot) => {
    const before = snapshot();
    act(handle);
    await sleep(60);
    frame = snapshot().slice(before.length).replace(ANSI, "");
  });
  return frame;
}

const longTranscript = (): Message[] => {
  const messages: Message[] = [userMessage("PROMPT-THAT-SCROLLS-OFF")];
  for (let i = 0; i < 10; i++) {
    messages.push(assistant([{ type: "text", content: `Reply number ${i}.` }]));
  }
  return messages;
};

test("scrolling up floats the pill over the last row", async () => {
  const { plain } = await renderPanel(longTranscript(), (handle) => handle.scrollToTop());
  expect(plain).toContain("Jump to bottom ↓");
});

/** Two prompts far apart, so which one the header names is observable: at the
 *  offset below the viewport holds only replies and BOTH prompts sit well above
 *  it — anything naming the older one came from the sticky header. */
const twoPromptTranscript = (): Message[] => {
  const messages: Message[] = [userMessage("OLD-PROMPT-TEXT")];
  for (let i = 0; i < 8; i++) {
    messages.push(assistant([{ type: "text", content: `Early reply ${i}.` }]));
  }
  messages.push(userMessage("NEW-PROMPT-TEXT"));
  for (let i = 0; i < 8; i++) {
    messages.push(assistant([{ type: "text", content: `Late reply ${i}.` }]));
  }
  return messages;
};

test("the header names the prompt the visible replies are answering", async () => {
  // Five rows up: the newer prompt's own "❯" row is at the top of the viewport,
  // so it is still on screen and the header falls back to the older prompt.
  const frame = await frameAfter(twoPromptTranscript(), (handle) => handle.scrollBy(-5));
  expect(frame).toContain("❯ OLD-PROMPT-TEXT");
  expect(frame).not.toContain("Early reply");
});

test("no breadcrumb while the view is pinned to the bottom", async () => {
  let frame = "";
  await renderPanel(twoPromptTranscript(), async (handle, snapshot) => {
    // Scrolled right up (the header names the older prompt), then back to the
    // bottom: the header must go, not switch to the newer prompt.
    handle.scrollBy(-20);
    await sleep(60);
    const before = snapshot();
    handle.scrollToBottom();
    await sleep(60);
    frame = snapshot().slice(before.length).replace(ANSI, "");
  });
  expect(frame).not.toContain("NEW-PROMPT-TEXT");
});
