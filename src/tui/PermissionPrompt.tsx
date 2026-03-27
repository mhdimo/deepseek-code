// Permission prompt — diff review with arrow-key picker and optional feedback

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface PermissionPromptProps {
  toolName: string;
  description: string;
  /** Full file path for file-related tools (Write, Edit) */
  filePath?: string;
  onApprove: (feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}

/** Render a single diff line with colored background */
function DiffLine({ line }: { line: string }) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("+")) {
    return (
      <Text wrap="wrap" backgroundColor="green" color="black" bold>
        {line || " "}
      </Text>
    );
  }
  if (trimmed.startsWith("-")) {
    return (
      <Text wrap="wrap" backgroundColor="red" color="white" bold>
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

  // Build the options list
  const options = isFileEdit
    ? ["Yes", "Yes, allow all edits during this session (shift+tab)", "No"]
    : isBash
      ? ["Yes", "Yes, allow all commands during this session", "No"]
      : ["Yes", "No"];

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
        const choice = options[selectedIdx];
        const feedback = feedbackText.trim() || undefined;
        if (choice === "Yes" || choice?.startsWith("Yes, allow all")) {
          onApprove(choice?.startsWith("Yes, allow all") ? feedback || "__allow_all__" : feedback);
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
      const choice = options[selectedIdx];
      if (choice === "Yes" || choice === "No") {
        setFeedbackMode(true);
      }
      return;
    }
    if (key.return) {
      const choice = options[selectedIdx];
      if (choice === "Yes") {
        onApprove();
      } else if (choice?.startsWith("Yes, allow all")) {
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
      return;
    }
  });

  // Extract lines and detect diff content
  const lines = description.split("\n");
  const diffOnly = lines.filter((l) => {
    const t = l.trimStart();
    return t.startsWith("+") || t.startsWith("-");
  });
  const hasDiff = diffOnly.length > 0;
  const maxDiffLines = 8;
  const diffLines = diffOnly.slice(0, maxDiffLines);
  const truncated = diffOnly.length > maxDiffLines;

  const shortFile = filePath
    ? filePath.split("/").pop() || filePath
    : null;

  // Determine which lines to show in the diff preview
  const previewLines = isFileEdit
    ? diffLines
    : isBash
      ? lines.slice(0, 4)
      : hasDiff
        ? diffLines
        : lines.slice(0, 6);

  return (
    <Box flexDirection="column" marginY={0}>
      {/* Header */}
      {isFileEdit && shortFile ? (
        <Box flexDirection="column">
          <Text color="cyan">Opened changes in editor</Text>
          <Text dimColor>Save file to continue…</Text>
          <Text></Text>
          <Text>
            Do you want to make this edit to <Text bold>{shortFile}</Text>?
          </Text>
        </Box>
      ) : isBash ? (
        <Box flexDirection="column">
          <Text>
            <Text color="yellow" bold>⚡</Text> Allow command execution?
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box>
            <Text color="yellow" bold>⚡ Permission required</Text>
          </Box>
          <Text>
            <Text bold>{toolName}</Text>
            <Text dimColor> wants to:</Text>
          </Text>
        </Box>
      )}

      {/* Unified diff/content preview — green bg for additions, red bg for deletions */}
      {previewLines.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={0}>
          {previewLines.map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
          {truncated && <Text dimColor>  … ({lines.length - maxDiffLines} more lines)</Text>}
        </Box>
      )}

      {/* Options picker */}
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => {
          const isActive = i === selectedIdx;
          const supportsFeedback = opt === "Yes" || opt === "No";
          // Show inline feedback input on the active option line
          if (isActive && feedbackMode) {
            return (
              <Box key={i}>
                <Text color="cyan" bold>❯ {i + 1}. {opt}: </Text>
                <Text bold>{feedbackText}</Text>
                <Text backgroundColor="cyan"> </Text>
                <Text dimColor> (Enter/Esc)</Text>
              </Box>
            );
          }
          return (
            <Text key={i} color={isActive ? "cyan" : undefined} bold={isActive}>
              {isActive ? "❯ " : "  "}{i + 1}. {opt}
              {isActive && supportsFeedback && (
                <Text dimColor> (tab for feedback)</Text>
              )}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
