import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../utils/theme.js";
import { StructuredDiff, parseDiffTextToHunk } from "./StructuredDiff.js";

interface PermissionPromptProps {
  toolName: string;
  description: string;
  /** Full file path for file-related tools (Write, Edit) */
  filePath?: string;
  onApprove: (feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}

interface DiffLineProps {
  line: string;
}

function DiffLine({ line }: DiffLineProps) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("+")) {
    return (
      <Text wrap="wrap" backgroundColor={theme.diffAdded} color={theme.inverseText} bold>
        {line || " "}
      </Text>
    );
  }
  if (trimmed.startsWith("-")) {
    return (
      <Text wrap="wrap" backgroundColor={theme.diffRemoved} color={theme.inverseText} bold>
        {line || " "}
      </Text>
    );
  }
  return (
    <Text wrap="wrap" dimColor>
      {line || " "}
    </Text>
  );
}

export default function PermissionPrompt({
  toolName,
  description,
  filePath,
  onApprove,
  onDeny,
}: PermissionPromptProps) {
  const isFileEdit = toolName === "Write" || toolName === "Edit";
  const isBash = toolName === "Bash";

  // Build options
  const options = isFileEdit
    ? [
        { label: "Yes", value: "yes" as const, hasFeedback: true },
        { label: "Yes, allow all edits during this session", value: "yes-all" as const, hasFeedback: false },
        { label: "No", value: "no" as const, hasFeedback: true },
      ]
    : isBash
      ? [
          { label: "Yes", value: "yes" as const, hasFeedback: true },
          { label: "Yes, allow all commands during this session", value: "yes-all" as const, hasFeedback: false },
          { label: "No", value: "no" as const, hasFeedback: true },
        ]
      : [
          { label: "Yes", value: "yes" as const, hasFeedback: true },
          { label: "No", value: "no" as const, hasFeedback: true },
        ];

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");

  useInput((input, key) => {
    // ── Feedback input mode ─────────────────────────────────────
    if (feedbackMode) {
      if (key.escape) {
        setFeedbackMode(false);
        setFeedbackText("");
        return;
      }
      if (key.return) {
        const choice = options[selectedIdx]!;
        const feedback = feedbackText.trim() || undefined;
        if (choice.value === "yes" || choice.value === "yes-all") {
          onApprove(choice.value === "yes-all" ? feedback || "__allow_all__" : feedback);
        } else {
          onDeny(feedback);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setFeedbackText((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFeedbackText((prev) => prev + input);
      }
      return;
    }

    // ── Normal picker mode ──────────────────────────────────────
    if (key.upArrow) {
      setSelectedIdx((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((prev) => Math.min(options.length - 1, prev + 1));
      return;
    }
    if (key.tab) {
      const choice = options[selectedIdx]!;
      if (choice.hasFeedback) {
        setFeedbackMode(true);
      }
      return;
    }
    if (key.return) {
      const choice = options[selectedIdx]!;
      if (choice.value === "yes") {
        onApprove();
      } else if (choice.value === "yes-all") {
        onApprove("__allow_all__");
      } else {
        onDeny();
      }
      return;
    }
    if (key.escape) {
      onDeny();
    }
    // Quick keys
    if (input === "y" || input === "Y") {
      onApprove();
      return;
    }
    if (input === "n" || input === "N") {
      onDeny();
    }
  });

  // Build diff/content preview
  const lines = description.split("\n");
  const diffOnly = lines.filter((l) => {
    const t = l.trimStart();
    return t.startsWith("+") || t.startsWith("-");
  });
  const hasDiff = diffOnly.length > 0;
  const maxPreviewLines = 10;
  const previewLines = isFileEdit
    ? diffOnly.slice(0, maxPreviewLines)
    : isBash
      ? lines.slice(0, 4)
      : hasDiff
        ? diffOnly.slice(0, maxPreviewLines)
        : lines.slice(0, 6);
  const truncated =
    (isFileEdit ? diffOnly.length : lines.length) > maxPreviewLines;

  const shortFile = filePath
    ? filePath.split("/").pop() || filePath
    : null;

  // Structured Diff support
  const cols = process.stdout.columns || 80;
  const diffWidth = Math.max(20, cols - 6);
  const hunk = isFileEdit ? parseDiffTextToHunk(description) : null;

  let headerText = "";
  let displayHunk = hunk;

  if (hunk) {
    const firstHunkLine = hunk.lines[0];
    if (firstHunkLine) {
      const idx = description.indexOf(firstHunkLine);
      if (idx !== -1) {
        headerText = description.slice(0, idx).trim();
      } else {
        headerText = description.split("\n")[0] || "";
      }
    }
    
    if (hunk.lines.length > maxPreviewLines) {
      displayHunk = {
        ...hunk,
        lines: hunk.lines.slice(0, maxPreviewLines),
      };
    }
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.permission}
      paddingX={1}
      marginY={0}
    >
      {/* Header */}
      <Box flexDirection="column">
        <Text bold color={theme.permission}>
          Allow {toolName}?
        </Text>

        {isFileEdit && shortFile && (
          <Text dimColor>
            {shortFile}
          </Text>
        )}
      </Box>

      {/* Diff/content preview */}
      {previewLines.length > 0 && (
        <Box flexDirection="column" marginTop={0}>
          {displayHunk ? (
            <Box flexDirection="column">
              {headerText ? (
                <Box marginBottom={1}>
                  <Text dimColor>{headerText}</Text>
                </Box>
              ) : null}
              <StructuredDiff patch={displayHunk} width={diffWidth} />
            </Box>
          ) : (
            previewLines.map((line, i) => (
              <DiffLine key={`diff-${i}`} line={line} />
            ))
          )}
          {truncated && (
            <Text dimColor>
              {" "}
              … ({(isFileEdit ? diffOnly.length : lines.length) - maxPreviewLines} more lines)
            </Text>
          )}
        </Box>
      )}

      {/* Options picker */}
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => {
          const isActive = i === selectedIdx;

          // Inline feedback mode
          if (isActive && feedbackMode) {
            return (
              <Box key={i}>
                <Text color={theme.assistant} bold>
                  {" ❯ "}
                </Text>
                <Text bold color={theme.assistant}>
                  {opt.label}:{" "}
                </Text>
                <Text bold>{feedbackText}</Text>
                <Text backgroundColor={theme.assistant}>{" "}</Text>
              </Box>
            );
          }

          return (
            <Box key={i}>
              <Text color={isActive ? theme.assistant : undefined} bold={isActive}>
                {isActive ? " ❯ " : "   "}
                {opt.label}
              </Text>
              {isActive && opt.hasFeedback && !feedbackMode && (
                <Text dimColor> (tab for feedback)</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Footer hints */}
      <Box marginTop={1}>
        <Text dimColor>
          Esc to cancel
          {options[selectedIdx]?.hasFeedback && " · Tab to amend"}
        </Text>
      </Box>
    </Box>
  );
}
