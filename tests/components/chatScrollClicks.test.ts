/**
 * The two scrolled-up affordances — the arrival pill at the bottom ("Jump to
 * bottom" / "N new messages ↓") and the sticky prompt row at the top — were
 * read-only chrome: the pill told you how to get back to the bottom and the
 * header told you which prompt you were reading, but neither could be
 * clicked, so the only way to use either was to reach for the keys.
 *
 * Both are click regions now. The pill runs the handle's scrollToBottom path,
 * and the header scrolls to the prompt it is showing — that prompt's own box
 * start row, so its "❯" row comes to rest just under the viewport top and the
 * header clears itself. Click-only, like the tab rows: neither carries a
 * hover handler. The hover dispatcher has no "pointer left" event to clear a
 * decoration with, and there is nothing here to highlight anyway — the pill's
 * destination is fixed and the header row is already a scroll destination.
 */
import { afterEach, expect, test } from "bun:test";
import React from "react";
import { Box } from "ink";
import chalk from "chalk";

// Ink colours through chalk and the test process has no TTY — raise the
// level so the hover tokens reach the frames (messageChrome.test.ts does
// the same).
chalk.level = 3;
import ChatPanel, { type ChatPanelHandle } from "../../src/components/ChatPanel.js";
import { elementRect, type ElementRect } from "../../src/components/mouseRegions.js";
import type { Message } from "../../src/types/index.js";
import {
  mountWithMouse,
  move,
  report,
  settle,
  write,
  type MountedMouseApp,
} from "./mouseTestHarness.js";

let apps: MountedMouseApp[] = [];
afterEach(() => {
  for (const app of apps) app.unmount();
  apps = [];
});

/** 30 turns of one-row text — far more than the 40-row fake terminal shows. */
function transcript(): Message[] {
  const messages: Message[] = [];
  for (let i = 1; i <= 30; i++) {
    messages.push({ role: "user", content: `PROMPT-${i} the quick brown fox`, timestamp: i });
    messages.push({
      role: "assistant",
      content: "",
      timestamp: i,
      blocks: [{ type: "text", content: `answer ${i} to the question above` }],
    });
  }
  return messages;
}

function mountPanel(): { app: MountedMouseApp; handle: ChatPanelHandle } {
  const ref = React.createRef<ChatPanelHandle>();
  const app = mountWithMouse(
    // The panel grows to fill whatever holds it (App wraps it the same way) —
    // without a bounded parent the transcript would be as tall as its content
    // and nothing could ever scroll.
    React.createElement(
      Box,
      { flexDirection: "column", width: 120, height: 40 },
      React.createElement(ChatPanel, {
        ref,
        messages: transcript(),
        isLoading: false,
        streamingText: "",
        streamingToolUse: [],
        version: "1.0.0",
        model: "deepseek-chat",
        workingDirectory: "/tmp",
        agentName: "code",
        providerType: "deepseek",
      } as never),
    ),
  );
  apps.push(app);
  return { app, handle: ref.current! };
}

/** Every region ChatPanel registered, top of screen first: header, then pill. */
function affordanceRects(app: MountedMouseApp): ElementRect[] {
  return [...app.registry.regions.values()]
    .map((region) => elementRect(region.ref.current))
    .filter((rect): rect is ElementRect => rect !== undefined)
    .sort((a, b) => a.top - b.top);
}

/** A left press one cell in from the region's top-left corner. */
async function click(app: MountedMouseApp, rect: ElementRect): Promise<void> {
  await write(app, report(0, rect.left + 2, rect.top + 1));
  await settle();
  await settle();
}

test("a click on the arrival pill jumps to the bottom", async () => {
  const { app, handle } = mountPanel();
  await settle();
  expect(handle.isAtBottom()).toBe(true);
  expect(affordanceRects(app).length).toBe(0); // at the bottom neither shows

  handle.scrollBy(-12); // into history
  await settle();
  await settle();
  expect(handle.isAtBottom()).toBe(false);

  const rects = affordanceRects(app);
  expect(rects.length).toBe(2); // the sticky header and the pill, nothing else
  const pill = rects[1]!;
  expect(pill.height).toBe(1);

  await click(app, pill);
  expect(app.selections.length).toBe(0); // the press was claimed, not anchored
  expect(handle.isAtBottom()).toBe(true); // back at the bottom
});

/** The prompt the sticky header is showing: the last prompt whose "❯" row
 *  has scrolled above the viewport top — stickyEntryFor's rule, read back off
 *  the row model rather than guessed from message heights. */
function headerPrompt(handle: ChatPanelHandle): number | null {
  for (let row = handle.getScrollTop() - 1; row >= 0; row--) {
    const match = /PROMPT-(\d+)/.exec(handle.getRowAt(row)?.text ?? "");
    if (match) return Number(match[1]);
  }
  return null;
}

test("a click on the sticky prompt row scrolls to that prompt", async () => {
  const { app, handle } = mountPanel();
  await settle();

  handle.scrollBy(-12); // into history
  await settle();
  await settle();
  expect(handle.isAtBottom()).toBe(false);

  const rects = affordanceRects(app);
  expect(rects.length).toBe(2);
  const header = rects[0]!;
  expect(header.height).toBe(1);

  const showing = headerPrompt(handle);
  expect(showing).not.toBeNull(); // the header is showing some prompt
  expect(showing).toBeGreaterThan(1); // …and not the transcript's first one

  await click(app, header);
  expect(app.selections.length).toBe(0);

  // The clicked prompt's box now starts at the viewport top, so its "❯" row
  // is the row just below it — and we are still scrolled up, not at either
  // end of the transcript. Its "❯" being visible is exactly where the header
  // stops showing it (stickyEntryFor), so the header has cleared.
  const top = handle.getScrollTop();
  expect(top).toBeGreaterThan(0);
  expect(handle.isAtBottom()).toBe(false);
  const underTop = /PROMPT-(\d+)/.exec(handle.getRowAt(top + 1)?.text ?? "");
  expect(underTop && Number(underTop[1])).toBe(showing);
});

/** Dark theme's userMessageBackgroundHover — rgb(70, 70, 70), distinct from
 *  the base rgb(55, 55, 55) the affordances rest on. Nothing else in the app
 *  paints this token, so its presence in a frame is the highlight itself. */
const HOVER_BG = "\u001b[48;2;70;70;70m";

test("hovering either affordance lights it, and moving off clears it", async () => {
  const { app, handle } = mountPanel();
  await settle();
  handle.scrollBy(-12);
  await settle();
  await settle();

  const rects = affordanceRects(app);
  const header = rects[0]!;
  const pill = rects[1]!;
  const resting = handle.getScrollTop();

  // The sticky row: the pointer inside it swaps its background for the hover
  // token, exactly as the reference's header does.
  let mark = app.frame().length;
  await move(app, header.left + 5, header.top + 1);
  await settle();
  expect(app.frame().slice(mark)).toContain(HOVER_BG);

  // The pill is its own region, so it lights the same way.
  mark = app.frame().length;
  await move(app, pill.left + 8, pill.top + 1);
  await settle();
  expect(app.frame().slice(mark)).toContain(HOVER_BG);

  // Off both — a transcript row — nothing is highlighted any more. (That the
  // region LEFT is the one cleared is the dispatcher's own test; here the
  // point is that the decoration does not stick to the pointer.)
  mark = app.frame().length;
  await move(app, 60, Math.floor((header.top + pill.top) / 2));
  await settle();
  expect(app.frame().slice(mark)).not.toContain(HOVER_BG);

  // Highlight and nothing more: no hover anywhere along the way moved the
  // viewport (a hover is not a gesture — same rule as every picker).
  expect(handle.getScrollTop()).toBe(resting);
});
