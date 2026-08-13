import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { type StructuredPatchHunk, diffWordsWithSpace } from "diff";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { getTheme, type Theme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";

export interface LineObject {
  code: string;
  i: number;
  type: "add" | "remove" | "nochange";
  originalCode: string;
}

interface DiffLine {
  code: string;
  type: "add" | "remove" | "nochange";
  i: number;
  originalCode: string;
}

interface StructuredDiffProps {
  patch: StructuredPatchHunk;
  dim?: boolean;
  width: number;
}





const CHANGE_THRESHOLD = 0.4;

function wrapText(text: string, maxWidth: number): string {
  return wrapAnsi(text, maxWidth, { trim: false, hard: true });
}











const FILL_ANCHOR = "​";

function bgWordFor(type: DiffLine["type"], dim: boolean, theme: Theme): string | undefined {
  if (type === "add") return dim ? theme.diffAddedDimmed : theme.diffAddedWord;
  if (type === "remove") return dim ? theme.diffRemovedDimmed : theme.diffRemovedWord;
  return undefined;
}

interface SlicedPart {
  value: string;
  isHighlight: boolean;
}

function sliceLineParts(
  lineParts: { value: string; isHighlight: boolean }[],
  start: number,
  len: number,
): SlicedPart[] {
  const result: SlicedPart[] = [];
  let currentOffset = 0;
  const end = start + len;

  for (const part of lineParts) {
    const partLen = part.value.length;
    const partStart = currentOffset;
    const partEnd = currentOffset + partLen;

    
    const overlapStart = Math.max(start, partStart);
    const overlapEnd = Math.min(end, partEnd);

    if (overlapStart < overlapEnd) {
      const sliceStart = overlapStart - partStart;
      const sliceEnd = overlapEnd - partStart;
      result.push({
        value: part.value.slice(sliceStart, sliceEnd),
        isHighlight: part.isHighlight,
      });
    }

    currentOffset = partEnd;
    if (currentOffset >= end) break;
  }

  return result;
}

function bgFor(type: DiffLine["type"], dim: boolean, theme: Theme): string | undefined {
  if (type === "add") return dim ? theme.diffAddedDimmed : theme.diffAdded;
  if (type === "remove") return dim ? theme.diffRemovedDimmed : theme.diffRemoved;
  return undefined;
}








function formatDiff(
  lines: string[],
  startingLineNumber: number,
  width: number,
  dim: boolean,
  theme: Theme,
): React.ReactNode[] {
  const safeWidth = Math.max(1, Math.floor(width));

  const lineObjects = transformLinesToObjects(lines);
  const ls = numberDiffLines(lineObjects, startingLineNumber);

  const maxLineNumber = Math.max(...ls.map(({ i }) => i), 0);
  const maxWidth = Math.max(maxLineNumber.toString().length + 1, 0);
  
  const prefixWidth = maxWidth + 2;
  const contentWidth = Math.max(1, safeWidth - prefixWidth);

  
  const lineHighlights = new Map<number, { value: string; isHighlight: boolean }[]>();
  const lsLength = ls.length;
  let idx = 0;
  while (idx < lsLength) {
    const currentLine = ls[idx];
    if (currentLine && currentLine.type === "remove") {
      const removes: number[] = [];
      while (idx < lsLength && ls[idx]?.type === "remove") {
        removes.push(idx);
        idx++;
      }
      const adds: number[] = [];
      while (idx < lsLength && ls[idx]?.type === "add") {
        adds.push(idx);
        idx++;
      }

      const pairCount = Math.min(removes.length, adds.length);
      for (let k = 0; k < pairCount; k++) {
        const removeIdx = removes[k]!;
        const addIdx = adds[k]!;

        const removeLine = ls[removeIdx]!;
        const addLine = ls[addIdx]!;

        
        
        const diffParts = diffWordsWithSpace(removeLine.code, addLine.code);

        
        
        const totalLength = removeLine.code.length + addLine.code.length;
        const changedLength = diffParts
          .filter((part) => part.added || part.removed)
          .reduce((sum, part) => sum + part.value.length, 0);
        const changeRatio = totalLength > 0 ? changedLength / totalLength : 0;
        if (changeRatio > CHANGE_THRESHOLD || dim) {
          continue;
        }

        const removeHighlights = diffParts
          .filter((part) => !part.added)
          .map((part) => ({
            value: part.value,
            isHighlight: !!part.removed,
          }));
        lineHighlights.set(removeIdx, removeHighlights);

        const addHighlights = diffParts
          .filter((part) => !part.removed)
          .map((part) => ({
            value: part.value,
            isHighlight: !!part.added,
          }));
        lineHighlights.set(addIdx, addHighlights);
      }
    } else {
      idx++;
    }
  }

  const rows: React.ReactNode[] = [];

  for (let lineIdx = 0; lineIdx < ls.length; lineIdx++) {
    const item = ls[lineIdx]!;
    const { type, code, i } = item;
    const lineNumStr =
      (i !== undefined ? i.toString().padStart(maxWidth) : " ".repeat(maxWidth)) + " ";
    const sigil = type === "add" ? "+" : type === "remove" ? "-" : " ";
    const bg = bgFor(type, dim, theme);
    const dimRow = dim || type === "nochange";

    
    
    const wrapped = wrapText(code, contentWidth).split("\n");
    const finalLines = wrapped.length === 0 ? [""] : wrapped;

    let offset = 0;
    finalLines.forEach((subLine, li) => {
      const prefix = li === 0 ? lineNumStr + sigil : " ".repeat(prefixWidth);
      const used = stringWidth(prefix) + stringWidth(subLine);
      const pad = Math.max(0, safeWidth - used);

      const highlights = lineHighlights.get(lineIdx);
      let contentNode: React.ReactNode;
      if (highlights) {
        const sliced = sliceLineParts(highlights, offset, subLine.length);
        contentNode = (
          <>
            {sliced.map((part, pIdx) => {
              const isReallyHighlighted = part.isHighlight && !dim;
              const partBg = isReallyHighlighted ? bgWordFor(type, dim, theme) : bg;
              return (
                <Text
                  key={pIdx}
                  backgroundColor={partBg}
                  color={isReallyHighlighted ? theme.inverseText : undefined}
                >
                  {part.value}
                </Text>
              );
            })}
          </>
        );
      } else {
        contentNode = subLine;
      }

      rows.push(
        <Box key={`${type}-${i}-${li}`} width={safeWidth} height={1}>
          <Text backgroundColor={bg} dimColor={dimRow} wrap="truncate">
            {prefix}
            {contentNode}
            {" ".repeat(pad)}
            {FILL_ANCHOR}
          </Text>
        </Box>,
      );

      offset += subLine.length;
    });
  }

  return rows;
}


export function transformLinesToObjects(lines: string[]): LineObject[] {
  return lines.map((code) => {
    if (code.startsWith("+")) {
      return { code: code.slice(1), i: 0, type: "add", originalCode: code.slice(1) };
    }
    if (code.startsWith("-")) {
      return { code: code.slice(1), i: 0, type: "remove", originalCode: code.slice(1) };
    }
    if (code.startsWith(" ")) {
      return { code: code.slice(1), i: 0, type: "nochange", originalCode: code.slice(1) };
    }
    return { code, i: 0, type: "nochange", originalCode: code };
  });
}

export function numberDiffLines(diff: LineObject[], startLine: number): DiffLine[] {
  let i = startLine;
  const result: DiffLine[] = [];
  const queue = [...diff];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const { code, type, originalCode } = current;
    const line = { code, type, i, originalCode };

    switch (type) {
      case "nochange":
        i++;
        result.push(line);
        break;
      case "add":
        i++;
        result.push(line);
        break;
      case "remove": {
        result.push(line);
        let numRemoved = 0;
        while (queue[0]?.type === "remove") {
          i++;
          const nextCurrent = queue.shift()!;
          result.push({
            code: nextCurrent.code,
            type: nextCurrent.type,
            i,
            originalCode: nextCurrent.originalCode,
          });
          numRemoved++;
        }
        i -= numRemoved;
        break;
      }
    }
  }
  return result;
}

export function StructuredDiff({ patch, dim = false, width }: StructuredDiffProps) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const diff = useMemo(
    () => formatDiff(patch.lines, patch.oldStart, width, dim, theme),
    [patch.lines, patch.oldStart, width, dim, theme],
  );

  return <Box flexDirection="column">{diff}</Box>;
}


export function parseDiffTextToHunk(diffText: string): StructuredPatchHunk | null {
  const allLines = diffText.split("\n");
  const diffLines = allLines.filter(
    (line) => line.startsWith("+") || line.startsWith("-") || line.startsWith(" "),
  );
  if (diffLines.length === 0) return null;

  const oldLines = diffLines.filter((l) => l.startsWith("-") || l.startsWith(" ")).length;
  const newLines = diffLines.filter((l) => l.startsWith("+") || l.startsWith(" ")).length;

  return {
    oldStart: 1,
    oldLines,
    newStart: 1,
    newLines,
    lines: diffLines,
  };
}
