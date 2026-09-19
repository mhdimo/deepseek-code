import React, { useLayoutEffect, useMemo, useRef } from "react";
import { Box, Text, type DOMElement } from "ink";
import type { Message, MessageBlock, ToolUseBlock } from "../types/index.js";
import { theme, resolveColor, getTheme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";
import Markdown, { RowText, rowSelection, markdownRows, flattenMarkdown, updateMarkdownModel, type MarkdownModelState, type MarkdownBlockRows } from "./Markdown.js";
import ToolBlock, { buildToolBlockSpans, BLACK_CIRCLE, type ToolBlockSpan } from "./ToolBlock.js";
import { AgentFanout, buildAgentFanoutLines } from "./AgentFanout.js";
import MessageResponse from "./MessageResponse.js";
import ThinkingBlock from "./ThinkingBlock.js";
import type { TextRow } from "../services/selection/lineModel.js";
import { wrapTextRuns } from "../services/selection/lineModel.js";
import type { ContentSelection } from "./useMouseSelection.js";

/** Columns consumed by <MessageResponse>'s "  ⎿  " gutter — the indent every
 *  response body (and now the compaction summary) is rendered behind. */
const GUTTER_WIDTH = 5;

/** One reported span of a message: its screen-row count, its model rows
 *  (for copy/highlight), and the width those rows wrap at. */
export interface BlockReport {
  key: string;
  rowCount: number;
  rows: TextRow[];
  width: number;
  /** Column where this span's box starts within the content area
   *  (the "● " / "❯ " prefix columns shift the text right). */
  leftOffset: number;
  kind: "text" | "plain" | "opaque";
}

interface MessageViewProps {
  message: Message;
  selectedToolCallId?: string | null;
  isTranscriptMode?: boolean;
  isStreaming?: boolean;
  /** Content width in cols (used to wrap rows). */
  contentWidth: number;
  /** Active selection (content coords) or null. */
  selection?: ContentSelection | null;
  /** Content row where this message begins (from ChatPanel's span map). */
  messageStartRow: number;
  /** Stable key for this message (report registry key). */
  blockKeyBase: string;
  /** Called during render with this message's block reports. */
  onBlockReport: (key: string, reports: BlockReport[]) => void;
}

interface TextBlockProps {
  content: string;
  isError?: boolean;
  width: number;
  selection: ContentSelection | null;
  startRow: number;
  /** Pre-built markdown model (streaming path) — avoids re-parsing. */
  model?: MarkdownBlockRows[];
}

/** Assistant text block: "● " marker + markdown.
 *
 *  No block cursor: the reference's streaming block is the dot plus
 *  StreamingMarkdown and nothing else (Messages.tsx:705-714 — the glyph shows
 *  up in the reference tree only as a ProgressBar fill), so ours used to be a
 *  row taller than Claude Code's and printed a character it never prints. */
function TextBlock({ content, isError, width, selection, startRow, model }: TextBlockProps) {
  if (isError) {
    return (
      <MessageResponse>
        <Text color={resolveColor(theme.error)} wrap="wrap">
          {content}
        </Text>
      </MessageResponse>
    );
  }
  return (
    <Box alignItems="flex-start" flexDirection="row" minWidth={0}>
      <Box minWidth={2} flexShrink={0}>
        <Text color={resolveColor(theme.text)}>{BLACK_CIRCLE}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Markdown dim={false} width={width} selection={selection} startRow={startRow} leftOffset={2} model={model}>
          {content}
        </Markdown>
      </Box>
    </Box>
  );
}

/** One renderable unit of an assistant message, in stream order, with the
 *  blank row that precedes it. */
export type AssistantUnit =
  | { kind: "spacer"; tag: string }
  | { kind: "thinking"; tag: string }
  | { kind: "block"; tag: string; index: number; block: MessageBlock }
  | { kind: "fanout"; tag: string; index: number; run: ToolUseBlock[] }
  | { kind: "legacy-text"; tag: string }
  | { kind: "legacy-tool"; tag: string; index: number; tool: ToolUseBlock };

/**
 * The assistant message's units in render order.
 *
 * Every unit carries its own leading blank row. The reference passes the
 * message-level `addMargin` down to EVERY content block (Message.tsx:105) and
 * each block applies `marginTop={addMargin ? 1 : 0}` — AssistantTextMessage
 * :228, AssistantToolUseMessage:182, AssistantThinkingMessage:41 — so Claude
 * Code prints a blank line before the prose, before each tool call and before
 * every following block. We emitted a single blank row at the top of the
 * message and then stacked the blocks flush, which reads as one dense run.
 *
 * (Our renderer has no per-message metadata header, so `hasMetadata` is always
 * false and `addMargin = !hasMetadata` — MessageRow.tsx:230-233 — holds in
 * transcript mode too.)
 */
export function assistantLayout(message: Message): AssistantUnit[] {
  const units: AssistantUnit[] = [];
  const hasBlocks = !!(message.blocks && message.blocks.length > 0);

  if (message.thinking) {
    units.push({ kind: "spacer", tag: "t:sp" });
    units.push({ kind: "thinking", tag: "t" });
  }

  if (hasBlocks) {
    const blocks = message.blocks!;
    let i = 0;
    while (i < blocks.length) {
      const block = blocks[i]!;
      // Consecutive Agent tool blocks collapse into one fanout tree and count
      // as a single unit — one blank row, like the group's own block.
      if (block.type === "tool" && block.block?.toolName === "Agent") {
        const run: ToolUseBlock[] = [];
        const runStart = i;
        while (
          i < blocks.length &&
          blocks[i]!.type === "tool" &&
          blocks[i]!.block?.toolName === "Agent"
        ) {
          run.push(blocks[i]!.block!);
          i++;
        }
        units.push({ kind: "spacer", tag: `b${runStart}:sp` });
        units.push({ kind: "fanout", tag: `b${runStart}`, index: runStart, run });
      } else {
        units.push({ kind: "spacer", tag: `b${i}:sp` });
        units.push({ kind: "block", tag: `b${i}`, index: i, block });
        i++;
      }
    }
  } else {
    if (message.content) {
      units.push({ kind: "spacer", tag: "c:sp" });
      units.push({ kind: "legacy-text", tag: "c" });
    }
    (message.toolUse ?? []).forEach((tool, index) => {
      units.push({ kind: "spacer", tag: `tool${index}:sp` });
      units.push({ kind: "legacy-tool", tag: `tool${index}`, index, tool });
    });
  }

  return units;
}

function MessageView({
  message,
  selectedToolCallId,
  isTranscriptMode,
  isStreaming = false,
  contentWidth,
  selection = null,
  messageStartRow,
  blockKeyBase,
  onBlockReport,
}: MessageViewProps) {
  const [themeName] = useTheme();
  const theme = useMemo(() => getTheme(themeName), [themeName]);
  const reportsRef = useRef<BlockReport[]>([]);
  const opaqueRefs = useRef(new Map<string, DOMElement | null>());
  const setOpaqueRef = React.useCallback((key: string) => {
    return (el: DOMElement | null) => {
      if (el) opaqueRefs.current.set(key, el);
    };
  }, []);
  /** setOpaqueRef's callbacks, cached per key: a fresh closure each render
   *  would be a new prop for ToolBlock's React.memo on every flush. */
  const opaqueRefCache = useRef(new Map<string, (el: DOMElement | null) => void>());
  const opaqueRefFor = (key: string): ((el: DOMElement | null) => void) => {
    let cb = opaqueRefCache.current.get(key);
    if (!cb) {
      cb = setOpaqueRef(key);
      opaqueRefCache.current.set(key, cb);
    }
    return cb;
  };
  /** Last measured rowCount per span key — gives opaque spans a stable
   *  height during render for the running-row accumulator (fresh spans
   *  count 0 for one frame; the parent re-renders with true starts as soon
   *  as this commit's measurement lands). */
  const lastRowCountsRef = useRef(new Map<string, number>());

  const report = (rep: BlockReport) => {
    reportsRef.current.push(rep);
  };

  // Measure opaque spans (tool/thinking/error blocks, spacers) after layout,
  // then report this message's spans to the panel. Runs after EVERY render
  // (no deps): children effects run before the parent's aggregation effect,
  // so the map is complete when ChatPanel reads it; the parent only bumps
  // state when the aggregated row counts actually change, so this cannot
  // loop.
  useLayoutEffect(() => {
    for (const rep of reportsRef.current) {
      if (rep.kind === "opaque") {
        const el = opaqueRefs.current.get(rep.key);
        const h = el?.yogaNode ? el.yogaNode.getComputedHeight() : 0;
        rep.rowCount = Math.max(1, h);
        lastRowCountsRef.current.set(rep.key, rep.rowCount);
      }
    }
    onBlockReport(blockKeyBase, reportsRef.current);
    reportsRef.current = [];
  });

  // Flattened rows per legacy text content — cached by content+width so
  // drag frames (selection changes) don't re-parse markdown.
  const rowsCache = useRef(new Map<string, TextRow[]>());
  const textRowsFor = (content: string, width: number): TextRow[] => {
    const k = width + ":" + content;
    let rows = rowsCache.current.get(k);
    if (!rows) {
      rows = flattenMarkdown(markdownRows(content, width, false, resolveColor(theme.permission)));
      rowsCache.current.set(k, rows);
      if (rowsCache.current.size > 300) rowsCache.current.clear();
    }
    return rows;
  };

  // Streaming text blocks share ONE incremental parse state keyed by the
  // block object (stable across flushes — App mutates the last text block
  // in place). Each flush re-parses only the appended tail, and unchanged
  // blocks keep their wrapped rows so Markdown's MemoBlock can bail out.
  const modelCacheRef = useRef(new WeakMap<MessageBlock, MarkdownModelState>());
  const textModelFor = (block: MessageBlock, width: number): MarkdownModelState => {
    const prev = modelCacheRef.current.get(block);
    const next = updateMarkdownModel(block.content ?? "", width, false, resolveColor(theme.permission), prev ?? null);
    modelCacheRef.current.set(block, next);
    return next;
  };

  // Tool spans keyed by block object identity. Completed Edit/Write blocks
  // carry the most expensive render data (Myers word diffs, wrap per line)
  // yet their output never changes between flushes — without this cache the
  // streaming message re-built every finished tool's spans ~12.5x/sec. App
  // replaces the block object whenever output/status/isExpanded change, so
  // the WeakMap misses exactly when the spans are stale.
  const toolSpanCacheRef = useRef(new WeakMap<ToolUseBlock, { width: number; isTranscriptMode: boolean; themeName: string; spans: ToolBlockSpan[] }>());
  const toolSpansFor = (tool: ToolUseBlock, contentWidth: number, isTranscript: boolean): ToolBlockSpan[] => {
    const cached = toolSpanCacheRef.current.get(tool);
    if (cached && cached.width === contentWidth && cached.isTranscriptMode === isTranscript && cached.themeName === themeName) {
      return cached.spans;
    }
    const spans = buildToolBlockSpans(tool, contentWidth, isTranscript, theme);
    toolSpanCacheRef.current.set(tool, { width: contentWidth, isTranscriptMode: isTranscript, themeName, spans });
    return spans;
  };

  /** Prompt text width: the row's 2-column "❯ " pointer plus the reference's
   *  `paddingRight={1}` on the background band (UserPromptMessage.tsx:76). */
  const userWidth = Math.max(1, contentWidth - 3);

  if (message.role === "user") {
    // A compaction summary is replayed to the model as a user turn, but the
    // user did not type it. Reference CompactSummary.tsx:92 collapses it to a
    // bold one-line label ("Compact summary" + the ctrl+o hint) and prints the
    // summary body only in transcript mode (line 100) — ours dumped the whole
    // generated summary into the transcript as a warning-coloured user row.
    //
    // The early return skips the prompt-row memo below. A compaction message
    // is never re-rendered as a typed prompt (it is keyed by its own
    // timestamp), so the hook order for an instance stays fixed.
    if (message.compaction) {
      const spacerKey = `${blockKeyBase}:sp`;
      report({ key: spacerKey, rowCount: 1, rows: [], width: contentWidth, leftOffset: 0, kind: "opaque" });
      const headKey = `${blockKeyBase}:compact-head`;
      // Measured after layout (the label can wrap on a narrow terminal);
      // assume the common single row until the measurement lands.
      const headRows = Math.max(1, lastRowCountsRef.current.get(headKey) ?? 0);
      report({ key: headKey, rowCount: 0, rows: [], width: contentWidth, leftOffset: 0, kind: "opaque" });
      const bodyWidth = Math.max(1, contentWidth - GUTTER_WIDTH);
      const bodyRows = isTranscriptMode
        ? wrapTextRuns([{ text: message.content }], bodyWidth)
        : [];
      if (bodyRows.length > 0) {
        report({
          key: `${blockKeyBase}:compact-body`,
          rowCount: bodyRows.length,
          rows: bodyRows,
          width: bodyWidth,
          leftOffset: GUTTER_WIDTH,
          kind: "plain",
        });
      }
      const bodyStart = messageStartRow + 1 + headRows;
      return (
        <Box flexDirection="column" flexShrink={0} minWidth={0}>
          <Box key={spacerKey} height={1} flexShrink={0} />
          <Box ref={setOpaqueRef(headKey)} flexDirection="row" flexShrink={0} minWidth={0}>
            <Box minWidth={2} flexShrink={0}>
              <Text color={resolveColor(theme.text)}>{BLACK_CIRCLE}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Text bold>
                Compact summary
                {!isTranscriptMode && <Text dimColor> (ctrl+o to expand)</Text>}
              </Text>
            </Box>
          </Box>
          {bodyRows.length > 0 && (
            <MessageResponse>
              <Box flexDirection="column" flexShrink={0} minWidth={0}>
                {bodyRows.map((r, i) => (
                  <Box key={i} height={1} flexShrink={0} minWidth={0}>
                    <RowText
                      row={r}
                      selCols={rowSelection(selection, bodyStart + i, GUTTER_WIDTH + (r.origin ?? 0), contentWidth)}
                      rowWidth={bodyWidth}
                    />
                  </Box>
                ))}
              </Box>
            </MessageResponse>
          )}
        </Box>
      );
    }

    const rows = useMemo(
      () => wrapTextRuns([{ text: message.content }], userWidth),
      [message.content, userWidth],
    );
    const spacerKey = `${blockKeyBase}:sp`;
    report({ key: spacerKey, rowCount: 1, rows: [], width: userWidth, leftOffset: 0, kind: "opaque" });
    report({
      key: `${blockKeyBase}:content`,
      rowCount: rows.length,
      rows,
      width: userWidth,
      leftOffset: 2,
      kind: "plain",
    });
    const start = messageStartRow + 1;
    return (
      <Box flexDirection="column" flexShrink={0} minWidth={0}>
        <Box key={spacerKey} height={1} flexShrink={0} />
        {/* The typed prompt sits on userMessageBackground with one column of
            right padding, and its pointer is figures.pointer in the subtle
            colour — not bold brand blue (UserPromptMessage.tsx:76,
            HighlightedThinkingText.tsx:24/:91). */}
        <Box
          flexDirection="row"
          minWidth={0}
          backgroundColor={resolveColor(theme.userMessageBackground)}
          paddingRight={1}
        >
          <Text color={resolveColor(theme.subtle)}>❯ </Text>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {rows.map((r, i) => (
              <Box key={i} height={1} flexShrink={0} minWidth={0}>
                <RowText
                  row={r}
                  selCols={rowSelection(selection, start + i, 2 + (r.origin ?? 0), contentWidth)}
                  rowWidth={userWidth}
                />
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
    );
  }

  if (message.role === "system") {
    const rows = useMemo(
      () => wrapTextRuns([{ text: message.content, style: { dim: true, italic: true } }], contentWidth),
      [message.content, contentWidth],
    );
    report({
      key: `${blockKeyBase}:content`,
      rowCount: rows.length,
      rows,
      width: contentWidth,
      leftOffset: 0,
      kind: "plain",
    });
    return (
      <Box flexDirection="column" flexShrink={0} minWidth={0}>
        {rows.map((r, i) => (
          <Box key={i} height={1} flexShrink={0} minWidth={0}>
            <RowText
              row={{ runs: r.runs.map((run) => ({ ...run, style: { italic: true, ...(run.style ?? {}) } })), softWrapped: r.softWrapped }}
              selCols={rowSelection(selection, messageStartRow + i, r.origin ?? 0, contentWidth)}
              rowWidth={contentWidth}
              dim
            />
          </Box>
        ))}
      </Box>
    );
  }

  if (message.role === "assistant") {
    const hasBlocks = !!(message.blocks && message.blocks.length > 0);
    const lastBlockIndex = hasBlocks ? message.blocks!.length - 1 : -1;
    const layout = assistantLayout(message);

    const fragments: React.ReactNode[] = [];
    let row = messageStartRow;
    const spacer = (tag: string) => {
      const k = `${blockKeyBase}:${tag}`;
      report({ key: k, rowCount: 1, rows: [], width: contentWidth, leftOffset: 0, kind: "opaque" });
      row++;
      fragments.push(
        <Box key={k} height={1} flexShrink={0} />,
      );
    };

    // Tool block: the head is an opaque row (measured — a multi-line shell
    // subject makes it taller than one); every content row is a model span
    // (computed here, rendered by ToolBlock from the same data), so the row
    // accumulator never drifts from what is on screen.
    const renderTool = (tool: ToolUseBlock, baseKey: string): React.ReactNode => {
      const spans = toolSpansFor(tool, contentWidth, isTranscriptMode ?? false);
      const headKey = `${baseKey}:head`;
      // One row until the measurement lands, like the compaction head.
      const headRows = Math.max(1, lastRowCountsRef.current.get(headKey) ?? 0);
      const headRow = row;
      row += headRows;
      report({ key: headKey, rowCount: headRows, rows: [], width: contentWidth, leftOffset: 0, kind: "opaque" });
      for (const s of spans) {
        row += s.rowCount;
        report({
          key: `${baseKey}:${s.key}`,
          rowCount: s.rowCount,
          rows: s.rows,
          width: s.width,
          leftOffset: s.leftOffset,
          kind: s.kind,
        });
      }
      return (
        <Box key={baseKey} flexShrink={0} minWidth={0}>
          <ToolBlock
            block={tool}
            spans={spans}
            isHighlighted={tool.toolCallId ? tool.toolCallId === selectedToolCallId : false}
            selection={selection}
            startRow={headRow + headRows}
            contentWidth={contentWidth}
            theme={theme}
            headRef={opaqueRefFor(headKey)}
          />
        </Box>
      );
    };

    // Consecutive Agent tool blocks collapse into one Claude Code-style tree
    // ("Running N agents…", ├─/└─ per agent). Renders its lines as opaque
    // rows so the row accumulator stays in sync with the screen.
    const renderAgentFanout = (run: ToolUseBlock[], baseKey: string): React.ReactNode => {
      // Compute the lines ONCE and reuse them for both the row accounting
      // and the render (building them twice meant two JSON.parse + full
      // output scans of every agent block per flush).
      const fanoutLines = buildAgentFanoutLines(run, theme);
      const lineCount = fanoutLines.length;
      row += lineCount;
      report({ key: `${baseKey}:fanout`, rowCount: lineCount, rows: [], width: contentWidth, leftOffset: 0, kind: "opaque" });
      return <AgentFanout key={baseKey} blocks={run} lines={fanoutLines} />;
    };

    const renderBlock = (block: MessageBlock, idx: number): React.ReactNode => {
      const key = `${blockKeyBase}:b${idx}`;
      if (block.type === "text" && block.content) {
        const textWidth = Math.max(1, contentWidth - 2);
        const model = textModelFor(block, textWidth);
        const rows = flattenMarkdown(model.model);
        const start = row;
        row += rows.length;
        if (message.isError) {
          const repKey = `${key}:err`;
          report({ key: repKey, rowCount: 0, rows: [], width: contentWidth, leftOffset: 0, kind: "opaque" });
          return (
            <Box key={key} ref={setOpaqueRef(repKey)} flexShrink={0} minWidth={0}>
              <TextBlock content={block.content} isError width={textWidth} selection={selection} startRow={start} />
            </Box>
          );
        }
        report({
          key,
          rowCount: rows.length,
          rows,
          width: textWidth,
          leftOffset: 2,
          kind: "text",
        });
        return (
          <Box key={key} flexShrink={0} minWidth={0}>
            <TextBlock content={block.content} width={textWidth} selection={selection} startRow={start} model={model.model} />
          </Box>
        );
      }
      if (block.type === "tool" && block.block) {
        return renderTool(block.block, `${key}:tool`);
      }
      if (block.type === "thinking") {
        const repKey = `${key}:thinking`;
        const h = lastRowCountsRef.current.get(repKey) ?? 0;
        row += h;
        report({ key: repKey, rowCount: 0, rows: [], width: contentWidth, leftOffset: 0, kind: "opaque" });
        return (
          <Box key={key} ref={setOpaqueRef(repKey)} flexShrink={0} minWidth={0}>
            <ThinkingBlock
              content={block.content || ""}
              isTranscriptMode={isTranscriptMode}
              isStreaming={isStreaming && idx === lastBlockIndex}
              width={contentWidth}
              selection={selection}
              startRow={row}
              thinkingStart={block.thinkingStart}
              thinkingEnd={block.thinkingEnd}
            />
          </Box>
        );
      }
      return null;
    };

    for (const unit of layout) {
      switch (unit.kind) {
        case "spacer":
          spacer(unit.tag);
          break;
        case "thinking": {
          const repKey = `${blockKeyBase}:t`;
          row += lastRowCountsRef.current.get(repKey) ?? 0;
          report({ key: repKey, rowCount: 0, rows: [], width: contentWidth, leftOffset: 0, kind: "opaque" });
          fragments.push(
            <Box key={repKey} ref={setOpaqueRef(repKey)} flexShrink={0} minWidth={0}>
              <ThinkingBlock
                content={message.thinking ?? ""}
                isTranscriptMode={isTranscriptMode}
                width={contentWidth}
                selection={selection}
                startRow={row}
              />
            </Box>,
          );
          break;
        }
        case "block":
          fragments.push(renderBlock(unit.block, unit.index));
          break;
        case "fanout":
          fragments.push(renderAgentFanout(unit.run, `${blockKeyBase}:fanout-${unit.index}`));
          break;
        case "legacy-text": {
          const textWidth = Math.max(1, contentWidth - 2);
          const rows = textRowsFor(message.content, textWidth);
          const start = row;
          row += rows.length;
          report({
            key: `${blockKeyBase}:legacy-content`,
            rowCount: rows.length,
            rows,
            width: textWidth,
            leftOffset: 2,
            kind: "text",
          });
          fragments.push(
            <Box key="legacy-content" flexShrink={0} minWidth={0}>
              <TextBlock content={message.content} isError={message.isError} width={textWidth} selection={selection} startRow={start} />
            </Box>,
          );
          break;
        }
        case "legacy-tool":
          fragments.push(renderTool(unit.tool, `${blockKeyBase}:tool${unit.index}`));
          break;
      }
    }

    return (
      <Box flexDirection="column" flexShrink={0} minWidth={0}>
        {fragments}
      </Box>
    );
  }

  return null;
}

export default React.memo(MessageView);
