import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";
import { StructuredDiff, parseDiffTextToHunk } from "./StructuredDiff.js";

interface PermissionPromptProps {
  toolName: string;
  description: string;
  
  filePath?: string;
  onApprove: (feedback?: string) => void;
  onDeny: (feedback?: string) => void;
  
  isTranscriptMode?: boolean;
}

interface DiffLineProps {
  line: string;
}



const DEFAULT_PLACEHOLDERS = {
  accept: "tell Claude what to do next",
  reject: "tell Claude what to do differently",
} as const;

function DiffLine({ line }: DiffLineProps) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
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
  isTranscriptMode = false,
}: PermissionPromptProps) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const isFileEdit = toolName === "Write" || toolName === "Edit";
  const isBash = toolName === "Bash";

  
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
    
    if (input === "y" || input === "Y") {
      onApprove();
      return;
    }
    if (input === "n" || input === "N") {
      onDeny();
    }
  });

  
  const lines = description.split("\n");
  const diffOnly = lines.filter((l) => {
    const t = l.trimStart();
    return t.startsWith("+") || t.startsWith("-");
  });
  const hasDiff = diffOnly.length > 0;
  const maxPreviewLines = isTranscriptMode ? 10000 : 10;
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

  
  
  
  const cols = process.stdout.columns || 80;
  const diffWidth = Math.max(20, cols - 6);
  const hunk = isFileEdit ? parseDiffTextToHunk(description) : null;

  
  const firstDescLine = description.split("\n")[0]?.trim() ?? "";
  const rawArgs = isFileEdit ? shortFile ?? "file" : firstDescLine;
  const args = rawArgs.length > 60 ? rawArgs.slice(0, 60).trimEnd() + "…" : rawArgs;

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
      {}
      <Text bold color={theme.permission}>
        {toolName}
        {args ? (
          <Text dimColor>
            ({args})
          </Text>
        ) : null}
      </Text>

      {}
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

      {}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Do you want to proceed?</Text>
        <Box flexDirection="column">
          {options.map((opt, i) => {
            const isActive = i === selectedIdx;

            
            
            
            if (isActive && feedbackMode) {
              const placeholder =
                opt.value === "no"
                  ? DEFAULT_PLACEHOLDERS.reject
                  : DEFAULT_PLACEHOLDERS.accept;
              return (
                <Box key={i}>
                  <Text color={theme.claude} bold>
                    {" ❯ "}
                  </Text>
                  <Text bold color={theme.claude}>
                    {opt.label}:{" "}
                  </Text>
                  <Text color={feedbackText ? undefined : theme.inactive} bold={!!feedbackText}>
                    {feedbackText || placeholder}
                  </Text>
                  <Text backgroundColor={theme.claude}>{" "}</Text>
                </Box>
              );
            }

            return (
              <Box key={i}>
                <Text color={isActive ? theme.claude : undefined} bold={isActive}>
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
      </Box>

      {}
      <Box marginTop={1}>
        <Text color={theme.inactive}>
          Esc to cancel
          {options[selectedIdx]?.hasFeedback && " · Tab to amend"}
        </Text>
      </Box>
    </Box>
  );
}
