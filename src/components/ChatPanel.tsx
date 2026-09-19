import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Text, type DOMElement } from "ink";
import type { Message, ToolUseBlock, MessageBlock } from "../types/index.js";
import MessageView, { type BlockReport } from "./MessageView.js";
import WelcomeScreen from "./WelcomeScreen.js";
import { buildStreamingAssistantMessage } from "./streamingMessage.js";
import type { ContentSelection } from "./useMouseSelection.js";
import { rowText, sliceTextByCols } from "../services/selection/lineModel.js";
import { resolveColor, getTheme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";

/** Figures.pointer — the prompt-glyph the sticky header and the user prompt
 *  both lead with. */
const PROMPT_POINTER = "❯";

/** Label for the scrolled-up pill: `N new messages` / `Jump to bottom`
 *  (FullscreenLayout.tsx:512). */
export function newMessagesPillLabel(count: number): string {
  if (count <= 0) return "Jump to bottom";
  return `${count} new ${count === 1 ? "message" : "messages"}`;
}

/** A tool-use-only assistant entry carries no text, so it is not what a user
 *  reads as "a new message" (FullscreenLayout.tsx:206). */
export function assistantHasVisibleText(m: Message): boolean {
  if (m.role !== "assistant") return false;
  if ((m.content ?? "").trim() !== "") return true;
  return (m.blocks ?? []).some((b) => b.type === "text" && (b.content ?? "").trim() !== "");
}

/** Counts assistant turns in messages[dividerIndex..end): one API response can
 *  produce several entries (thinking + tool_use + text), but the user thinks of
 *  it as one message. Ported from FullscreenLayout.tsx:198. */
export function countUnseenAssistantTurns(messages: readonly Message[], dividerIndex: number): number {
  let count = 0;
  let prevWasAssistant = false;
  for (let i = Math.max(0, dividerIndex); i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "assistant" && !assistantHasVisibleText(m)) continue;
    const isAssistant = m.role === "assistant";
    if (isAssistant && !prevWasAssistant) count++;
    prevWasAssistant = isAssistant;
  }
  return count;
}

/** What a message contributes to the sticky header, or null when it has no
 *  prompt to show — a compaction summary was not typed by the user
 *  (VirtualMessageList.tsx:133 skips meta entries the same way). */
export function stickyPromptText(m: Message): string | null {
  if (m.role !== "user" || m.compaction) return null;
  const text = (m.content ?? "").trim();
  return text === "" ? null : text;
}

/** The most recent prompt whose "❯" row has scrolled above the viewport top.
 *  The prompt's own box starts at startRow and its "❯" sits one row below it
 *  (the marginTop row), so a prompt whose pointer is still on screen would just
 *  repeat a line the user can already see (VirtualMessageList.tsx:948). */
export function stickyPromptFor(
  entries: readonly { text: string; startRow: number }[],
  scrollTop: number,
): string | null {
  if (scrollTop <= 0) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.startRow + 1 < scrollTop) return entry.text;
  }
  return null;
}

export interface ViewportInfo {
  /** Screen rows above content row 0 (banner/padding chain). */
  topOffset: number;
  /** Total content rows. */
  totalRows: number;
  /** Content width in cols. */
  width: number;
  /** Current scroll offset in rows. */
  scrollTop: number;
}

/** Text content + column origin of one content row (for word selection). */
export interface RowAt {
  text: string;
  /** Column offset of the row's text within the content area. */
  origin: number;
}

export interface ChatPanelHandle {
  scrollBy: (dy: number) => void;
  /** Snap the scroll into the collapsed-content range the moment transcript
   *  mode exits — before ink has re-laid-out the shrunken DOM — so the first
   *  frame after exit is already correct (no blank viewport flash). */
  snapBackAfterCollapse: () => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  scrollPage: (dir: 1 | -1) => void;
  scrollHalf: (dir: 1 | -1) => void;
  isAtBottom: () => boolean;
  /** Current scroll offset in rows (read-only; used by tests/probes). */
  getScrollTop: () => number;
  /** Viewport geometry in content coordinates (mouse selection). */
  getViewport: () => ViewportInfo | null;
  /** Text at a content row (mouse selection), or null when the row is
   *  opaque (tool blocks etc.) or outside the transcript. */
  getRowAt: (contentRow: number) => RowAt | null;
  /** Extract the visible text covered by a content-coordinate selection. */
  copySelection: (sel: ContentSelection) => string;
}

interface ChatPanelProps {
  messages: Message[];
  isLoading: boolean;
  streamingText: string;
  streamingToolUse: ToolUseBlock[];
  version: string;
  model: string;
  workingDirectory: string;
  agentName: string;
  providerType: string;
  baseURL?: string;
  hasApiKey?: boolean;
  selectedToolCallId?: string | null;
  streamingBlocks?: MessageBlock[];
  isTranscriptMode?: boolean;
  /** Active selection (content coords) or null. */
  selection?: ContentSelection | null;

  freezeWelcome?: boolean;
}

export default React.memo(
  forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
    {
      messages,
      isLoading,
      streamingText,
      streamingToolUse,
      version,
      model,
      workingDirectory,
      agentName,
      providerType,
      baseURL,
      hasApiKey = true,
      selectedToolCallId = null,
      streamingBlocks = [],
      freezeWelcome = false,
      isTranscriptMode = false,
      selection = null,
    }: ChatPanelProps,
    ref,
  ) {
    const streamingMessage = isLoading
      ? buildStreamingAssistantMessage(streamingBlocks, streamingText, streamingToolUse)
      : null;
    const visibleMessages = streamingMessage ? [...messages, streamingMessage] : messages;

    const viewportRef = useRef<DOMElement | null>(null);
    const contentRef = useRef<DOMElement | null>(null);
    const stickyRef = useRef(true);
    const scrollTopRef = useRef(0);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const [viewportWidth, setViewportWidth] = useState(0);
    const [themeName] = useTheme();
    const colorTheme = useMemo(() => getTheme(themeName), [themeName]);

    /** Index into visibleMessages where the user last left the bottom. New
     *  turns from there on feed the "N new messages" pill; null while pinned
     *  to the bottom (FullscreenLayout.tsx's useUnseenDivider). The ref mirrors
     *  the state for the once-created imperative handle, whose closures would
     *  otherwise read a stale value. */
    const [dividerIndex, setDividerIndex] = useState<number | null>(null);
    const dividerIndexRef = useRef<number | null>(null);
    const markScrollAway = useCallback((messageCount: number) => {
      if (dividerIndexRef.current !== null) return;
      dividerIndexRef.current = messageCount;
      setDividerIndex(messageCount);
    }, []);
    const markRepinned = useCallback(() => {
      dividerIndexRef.current = null;
      setDividerIndex(null);
    }, []);

    // Span registry: message key → BlockReport[] (reported by children in
    // their layout effects, which run before this component's effects).
    const spansRef = useRef(new Map<string, BlockReport[]>());
    /** Last known total rows per message key (fallback for messages whose
     *  spans haven't landed yet — e.g. a just-finalized stream). */
    const lastTotalsRef = useRef(new Map<string, number>());
    const lastAggKeyRef = useRef("");
    const [, setSpansTick] = useState(0);
    /** Total content rows the LAST time transcript mode was OFF. Thinking
     *  blocks collapse back to the same rows, so this is the exact height
     *  the content will have right after exiting transcript mode — used by
     *  snapBackAfterCollapse() to clamp scrollTop before ink re-lays-out. */
    const collapsedTotalsRef = useRef(0);

    const onBlockReport = useCallback((key: string, reports: BlockReport[]) => {
      spansRef.current.set(key, reports);
    }, []);

    const messageKey = (m: Message, idx: number): string =>
      streamingMessage === m ? "streaming-assistant" : `msg-${m.timestamp}-${idx}`;

    const spanTotal = (key: string): number => {
      const spans = spansRef.current.get(key);
      if (!spans) return lastTotalsRef.current.get(key) ?? 0;
      let total = 0;
      for (const s of spans) total += s.rowCount;
      return total;
    };

    // Aggregate child reports and re-render when the row structure changed
    // (new measurements land after content growth). Runs after every render;
    // only bumps state when the aggregate actually differs, so this cannot
    // loop.
    useLayoutEffect(() => {
      const parts: string[] = [];
      for (let i = 0; i < visibleMessages.length; i++) {
        const key = messageKey(visibleMessages[i]!, i);
        const total = spanTotal(key);
        if (spansRef.current.has(key)) lastTotalsRef.current.set(key, total);
        parts.push(`${key}:${total}`);
      }
      const agg = parts.join("|");
      if (agg !== lastAggKeyRef.current) {
        lastAggKeyRef.current = agg;
        setSpansTick((t) => t + 1);
      }
    });

    // Live refs for the (once-created) imperative handle.
    const liveRef = useRef({ visibleMessages, messageKey, spanTotal });
    liveRef.current = { visibleMessages, messageKey, spanTotal };

    const measure = () => {
      // Viewport height comes from the PARENT (the app's chat-area wrapper),
      // not this box's own flex-derived height — the negative translate margin
      // feeds back into the flex sizing of this box's chain and makes its own
      // computed height wobble by ±1-3 rows between renders (which shifts the
      // clip boundary). The parent sits outside the scroll chain and is stable.
      const vh = viewportRef.current?.parentNode?.yogaNode?.getComputedHeight() ?? 0;
      // Content height: the content box flex-grows to fill the viewport, so
      // its computed height becomes `vh + scrollTop` whenever the content is
      // SHORTER than the viewport — the negative translate margin feeds into
      // the flex free-space. That makes `ch - vh` equal scrollTop (an
      // identity), so a clamp against it can never recover from a scrollTop
      // left past the end of content when it collapses (e.g. exiting ctrl+o
      // transcript mode). The span registry is the true content height.
      let realContent = 0;
      for (let i = 0; i < visibleMessages.length; i++) {
        realContent += spanTotal(messageKey(visibleMessages[i]!, i));
      }
      const vw = viewportRef.current?.yogaNode?.getComputedWidth() ?? 0;
      return { vh, vw, max: Math.max(0, realContent - vh) };
    };

    const applyScroll = (next: number) => {
      scrollTopRef.current = next;
      setScrollTop(next);
    };

    // Pre-paint shrink clamp: children's layout effects (which run before
    // this one) just measured the newly committed content, so the span map
    // is current. If content collapsed below the scroll position (e.g. on
    // exiting ctrl+o transcript mode), snap scrollTop back into range NOW —
    // before ink paints this frame — so the user never sees a blank
    // viewport, even for one frame.
    useLayoutEffect(() => {
      let real = 0;
      for (let i = 0; i < visibleMessages.length; i++) {
        real += spanTotal(messageKey(visibleMessages[i]!, i));
      }
      if (!isTranscriptMode) collapsedTotalsRef.current = real;
      const max = Math.max(0, real - viewportHeight);
      if (scrollTopRef.current > max) applyScroll(max);
    });

    // Sticky follow: after every render, if pinned to the bottom, re-pin to
    // the new bottom as content grows. Also pin the viewport's own height so
    // the scroll translate (negative margin) never feeds back into the flex
    // sizing of the parent chain — a flex-derived viewport height wobbles by
    // ±1-3 rows between renders, which shifts the clip boundary and clips or
    // bleeds the last content row. Deferred past ink's render pass
    // (setTimeout lands after ink's layout microtask), so the yoga
    // measurements reflect the content we just committed.
    useEffect(() => {
      const t = setTimeout(() => {
        const { vh, vw, max } = measure();
        if (vh !== viewportHeight) setViewportHeight(vh);
        if (vw !== viewportWidth) setViewportWidth(vw);
        // Clamp when content shrank below the current scroll position —
        // even while the user is scrolled up (not sticky). Otherwise the
        // viewport renders past the end of content and goes blank (e.g.
        // exiting ctrl+o transcript mode mid-scroll).
        if (scrollTopRef.current > max) applyScroll(max);
        else if (stickyRef.current && scrollTopRef.current !== max) applyScroll(max);
      }, 0);
      return () => clearTimeout(t);
    });

    // Per-message content start rows, accumulated from the aggregated spans
    // (a message whose spans are still missing counts as 0 for one frame —
    // it is always the last message, so nothing follows it).
    const starts = new Map<string, number>();
    let contentRows = 0;
    {
      let acc = 0;
      for (let i = 0; i < visibleMessages.length; i++) {
        const key = messageKey(visibleMessages[i]!, i);
        starts.set(key, acc);
        acc += spanTotal(key);
      }
      contentRows = acc;
    }

    // /clear, rewind and a mid-scroll compaction all replace the transcript —
    // a divider pointing past the new end would count turns that are gone.
    useEffect(() => {
      if (dividerIndex !== null && visibleMessages.length < dividerIndex) markRepinned();
    }, [dividerIndex, visibleMessages.length, markRepinned]);

    const maxScroll = Math.max(0, contentRows - viewportHeight);
    /** Off the bottom: pinned to it the whole transcript is what you are
     *  reading, so neither scrolled-up affordance belongs on screen. */
    const scrolledUp = scrollTop < maxScroll;
    const unseenCount = dividerIndex === null ? 0 : countUnseenAssistantTurns(visibleMessages, dividerIndex);
    /** The pill lingers while the viewport is off the bottom, showing
     *  "Jump to bottom" until something new actually arrives
     *  (FullscreenLayout.tsx:466). */
    const pillVisible = dividerIndex !== null && scrolledUp;
    const promptEntries: { text: string; startRow: number }[] = [];
    for (let i = 0; i < visibleMessages.length; i++) {
      const text = stickyPromptText(visibleMessages[i]!);
      if (text !== null) {
        promptEntries.push({ text, startRow: starts.get(messageKey(visibleMessages[i]!, i)) ?? 0 });
      }
    }
    // The tracker only pins a prompt once sticky scroll has broken
    // (VirtualMessageList.tsx:948) — at the bottom the header would just sit
    // above the transcript you are already following.
    const stickyPrompt = scrolledUp ? stickyPromptFor(promptEntries, scrollTop) : null;

    useImperativeHandle(
      ref,
      () => {
        // The handle is created ONCE ([] deps), so it must never close over
        // render-scoped values: the first render's `visibleMessages` is empty
        // (the session loads asynchronously), which made every scroll method
        // clamp against max=0 and get re-pinned to the bottom by the sticky
        // effect — scroll keys were dead in transcript mode. liveRef is
        // updated every render and carries the live messages + key/span
        // accessors.
        const measure = () => {
          const live = liveRef.current;
          const vh = viewportRef.current?.parentNode?.yogaNode?.getComputedHeight() ?? 0;
          let realContent = 0;
          for (let i = 0; i < live.visibleMessages.length; i++) {
            realContent += live.spanTotal(live.messageKey(live.visibleMessages[i]!, i));
          }
          const vw = viewportRef.current?.yogaNode?.getComputedWidth() ?? 0;
          return { vh, vw, max: Math.max(0, realContent - vh) };
        };
        /** Snapshot the unseen-divider on the FIRST scroll away from the
         *  bottom, clear it on any re-pin. Nothing below the viewport means
         *  nothing to jump to, so a scroll action that stays at max is a
         *  re-pin, not a scroll-away (a wheel-up on a fresh session used to
         *  show the pill for an empty transcript). */
        const trackSticky = () => {
          const { max } = measure();
          if (scrollTopRef.current >= max) {
            stickyRef.current = true;
            markRepinned();
          } else {
            stickyRef.current = false;
            markScrollAway(liveRef.current.visibleMessages.length);
          }
        };
        const scrollBy = (dy: number) => {
          const { max } = measure();
          const next = Math.max(0, Math.min(scrollTopRef.current + dy, max));
          stickyRef.current = next >= max;
          if (stickyRef.current) markRepinned();
          else markScrollAway(liveRef.current.visibleMessages.length);
          applyScroll(next);
        };
        return {
          scrollBy,
          snapBackAfterCollapse() {
            stickyRef.current = true;
            markRepinned();
            // Parent's yoga height is stable across the transcript toggle
            // (only the chat content box changes), so it is valid at call
            // time — even mid-render, before the collapse commits.
            const vh = viewportRef.current?.parentNode?.yogaNode?.getComputedHeight() ?? 0;
            const max = Math.max(0, collapsedTotalsRef.current - vh);
            applyScroll(max);
          },
          scrollToTop() {
            applyScroll(0);
            trackSticky();
          },
          scrollToBottom() {
            stickyRef.current = true;
            markRepinned();
            const { max } = measure();
            applyScroll(max);
          },
          scrollPage(dir: 1 | -1) {
            const { vh } = measure();
            scrollBy(dir * Math.max(1, vh - 2));
          },
          scrollHalf(dir: 1 | -1) {
            const { vh } = measure();
            scrollBy(dir * Math.max(1, Math.floor(vh / 2)));
          },
          isAtBottom() {
            return stickyRef.current || scrollTopRef.current >= measure().max - 1;
          },
          getScrollTop() {
            return scrollTopRef.current;
          },
          getViewport() {
            let top = 0;
            let el: DOMElement | null = viewportRef.current;
            while (el?.yogaNode) {
              top += el.yogaNode.getComputedTop();
              el = el.parentNode as DOMElement | null;
            }
            const live = liveRef.current;
            let totalRows = 0;
            for (let i = 0; i < live.visibleMessages.length; i++) {
              totalRows += live.spanTotal(live.messageKey(live.visibleMessages[i]!, i));
            }
            return {
              topOffset: top,
              totalRows,
              width: Math.max(1, viewportRef.current?.yogaNode?.getComputedWidth() ?? 80),
              scrollTop: scrollTopRef.current,
            };
          },
          getRowAt(contentRow: number) {
            const live = liveRef.current;
            let acc = 0;
            for (let i = 0; i < live.visibleMessages.length; i++) {
              const key = live.messageKey(live.visibleMessages[i]!, i);
              const spans = spansRef.current.get(key);
              if (!spans) continue;
              for (const span of spans) {
                if (contentRow < acc + span.rowCount) {
                  if (span.kind === "opaque" || span.rows.length === 0) return null;
                  const localRow = contentRow - acc;
                  const row = span.rows[localRow];
                  if (!row) return null;
                  return {
                    text: rowText(row),
                    origin: span.leftOffset + (row.origin ?? 0),
                  };
                }
                acc += span.rowCount;
              }
            }
            return null;
          },
          copySelection(sel) {
            const live = liveRef.current;
            const parts: string[] = [];
            let acc = 0;
            for (let i = 0; i < live.visibleMessages.length; i++) {
              const key = live.messageKey(live.visibleMessages[i]!, i);
              const spans = spansRef.current.get(key);
              if (!spans) continue;
              for (const span of spans) {
                const spanStart = acc;
                acc += span.rowCount;
                if (span.kind === "opaque" || span.rows.length === 0) continue;
                const r0 = Math.max(sel.startRow, spanStart);
                const r1 = Math.min(sel.endRow, spanStart + span.rows.length - 1);
                if (r0 > r1) continue;
                const fromCol = Math.max(0, sel.startCol - span.leftOffset);
                const toCol = Math.max(fromCol, Math.min(sel.endCol - span.leftOffset, span.width));
                for (let r = r0; r <= r1; r++) {
                  const row = span.rows[r - spanStart];
                  const text = row ? rowText(row) : "";
                  const fc = r === r0 ? fromCol : 0;
                  const tc = r === r1 ? toCol : span.width;
                  parts.push(sliceTextByCols(text, fc, tc));
                  if (!row || !row.softWrapped) parts.push("\n");
                }
              }
            }
            return parts.join("").trimEnd();
          },
        };
      },
      [],
    );

    return (
      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={viewportHeight ? 0 : 1}
        flexShrink={viewportHeight ? 0 : 1}
        minHeight={0}
        height={viewportHeight || undefined}
        overflow="hidden"
      >
        {messages.length === 0 && (
          <Box marginBottom={1}>
            <WelcomeScreen
              version={version}
              model={model}
              workingDirectory={workingDirectory}
              agentName={agentName}
              providerType={providerType}
              baseURL={baseURL}
              hasApiKey={hasApiKey}
              frozen={freezeWelcome}
            />
          </Box>
        )}

        {/* Context breadcrumb: scrolled up into history, the prompt the current
            turn is answering stays pinned to the top of the viewport, so you
            know what is being answered without scrolling back
            (FullscreenLayout.tsx:551-580). Normal flow, exactly like the
            reference's header — the transcript gives up the row. */}
        {stickyPrompt && (
          <Box
            flexShrink={0}
            width="100%"
            height={1}
            paddingRight={1}
            backgroundColor={resolveColor(colorTheme.userMessageBackground)}
          >
            <Text color={resolveColor(colorTheme.subtle)} wrap="truncate-end">
              {PROMPT_POINTER} {stickyPrompt}
            </Text>
          </Box>
        )}

        {/* The transcript's own clip region, so the header above keeps its row:
            the content is translated up by scrollTop, and without this box the
            row scrolled just past the top would land on the header and paint
            over it (Ink draws children in tree order). */}
        <Box flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
          <Box
            ref={contentRef}
            flexDirection="column"
            flexGrow={1}
            flexShrink={0}
            minHeight={0}
            marginTop={scrollTop > 0 ? -scrollTop : 0}
          >
            {visibleMessages.map((m, idx) => (
              <MessageView
                key={messageKey(m, idx)}
                message={m}
                selectedToolCallId={selectedToolCallId}
                isTranscriptMode={isTranscriptMode}
                isStreaming={streamingMessage === m}
                contentWidth={viewportWidth > 0 ? viewportWidth : 80}
                selection={selection}
                messageStartRow={starts.get(messageKey(m, idx)) ?? 0}
                blockKeyBase={messageKey(m, idx)}
                onBlockReport={onBlockReport}
              />
            ))}
          </Box>
        </Box>

        {/* Arrival affordance: scrolled away from the bottom, a centered band
            floats over the last row with how much arrived since — or just how
            to get back when nothing has (FullscreenLayout.tsx:520-529).
            Absolutely positioned, so it never costs the transcript a row. */}
        {pillVisible && (
          <Box
            position="absolute"
            width="100%"
            marginTop={Math.max(0, viewportHeight - 1)}
            justifyContent="center"
          >
            <Text backgroundColor={resolveColor(colorTheme.userMessageBackground)} dimColor>
              {" "}
              {newMessagesPillLabel(unseenCount)}
              {" ↓ "}
            </Text>
          </Box>
        )}
      </Box>
    );
  }),
);
