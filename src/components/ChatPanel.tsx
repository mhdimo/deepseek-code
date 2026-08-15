import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Box, type DOMElement } from "ink";
import type { Message, ToolUseBlock, MessageBlock } from "../types/index.js";
import MessageView, { type BlockReport } from "./MessageView.js";
import WelcomeScreen from "./WelcomeScreen.js";
import { buildStreamingAssistantMessage } from "./streamingMessage.js";
import type { ContentSelection } from "./useMouseSelection.js";
import { rowText, sliceTextByCols } from "../services/selection/lineModel.js";

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
    {
      let acc = 0;
      for (let i = 0; i < visibleMessages.length; i++) {
        const key = messageKey(visibleMessages[i]!, i);
        starts.set(key, acc);
        acc += spanTotal(key);
      }
    }

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
        const scrollBy = (dy: number) => {
          const { max } = measure();
          const next = Math.max(0, Math.min(scrollTopRef.current + dy, max));
          stickyRef.current = next >= max;
          applyScroll(next);
        };
        return {
          scrollBy,
          snapBackAfterCollapse() {
            stickyRef.current = true;
            // Parent's yoga height is stable across the transcript toggle
            // (only the chat content box changes), so it is valid at call
            // time — even mid-render, before the collapse commits.
            const vh = viewportRef.current?.parentNode?.yogaNode?.getComputedHeight() ?? 0;
            const max = Math.max(0, collapsedTotalsRef.current - vh);
            applyScroll(max);
          },
          scrollToTop() {
            stickyRef.current = false;
            applyScroll(0);
          },
          scrollToBottom() {
            stickyRef.current = true;
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
    );
  }),
);
