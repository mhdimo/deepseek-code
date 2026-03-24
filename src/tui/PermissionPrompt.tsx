// Permission prompt with picker + optional feedback

import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import InkTextInput from "ink-text-input";

interface PermissionPromptProps {
  toolName: string;
  description: string;
  onApprove: (feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}

export default function PermissionPrompt({
  toolName,
  description,
  onApprove,
  onDeny,
}: PermissionPromptProps) {
  const [selected, setSelected] = useState<"approve" | "deny">("approve");
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState("");

  const descriptionLines = description.split("\n");
  const hasDiff = useMemo(
    () => descriptionLines.some((line) => line.trimStart().startsWith("+") || line.trimStart().startsWith("-")),
    [descriptionLines],
  );

  const lineColor = (line: string): string | undefined => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("+")) return "green";
    if (trimmed.startsWith("-")) return "red";
    if (trimmed.startsWith("@@") || trimmed === "Diff preview:") return "cyan";
    return undefined;
  };

  useInput((input, key) => {
    if (feedbackMode) {
      if (key.escape) {
        setFeedbackMode(false);
        return;
      }
      if (key.return) {
        const note = feedback.trim() || undefined;
        if (selected === "approve") onApprove(note);
        else onDeny(note);
      }
      return;
    }

    if (key.upArrow || key.downArrow || key.tab) {
      setSelected((prev) => (prev === "approve" ? "deny" : "approve"));
      return;
    }

    if (input === "f" || input === "F") {
      setFeedbackMode(true);
      return;
    }

    if (input === "y" || input === "Y") {
      onApprove();
      return;
    }

    if (input === "n" || input === "N") {
      onDeny();
      return;
    }

    if (key.return) {
      if (selected === "approve") onApprove();
      else onDeny();
      return;
    }

    if (key.escape) {
      onDeny();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={0}
      marginY={0}
    >
      <Box>
        <Text color="yellow" bold>
          ⚡ Permission required
        </Text>
      </Box>
      <Box>
        <Text>
          <Text bold>{toolName}</Text>
          <Text dimColor> wants to:</Text>
        </Text>
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        {descriptionLines.map((line, i) => (
          <Text key={`${toolName}-line-${i}`} wrap="wrap" color={lineColor(line)} dimColor={!lineColor(line)}>
            {line || " "}
          </Text>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Decision</Text>
        <Text color={selected === "approve" ? "green" : undefined} bold={selected === "approve"}>
          {selected === "approve" ? "▸ " : "  "}Approve
        </Text>
        <Text color={selected === "deny" ? "red" : undefined} bold={selected === "deny"}>
          {selected === "deny" ? "▸ " : "  "}Deny
        </Text>
      </Box>

      {feedbackMode && (
        <Box marginTop={1}>
          <Text dimColor>Feedback: </Text>
          <InkTextInput
            value={feedback}
            onChange={setFeedback}
            onSubmit={() => {
              const note = feedback.trim() || undefined;
              if (selected === "approve") onApprove(note);
              else onDeny(note);
            }}
            placeholder="Add feedback for this tool action..."
            focus={true}
          />
        </Box>
      )}

      <Box>
        <Text dimColor>
          ↑↓/Tab pick · Enter confirm · y approve · n deny · f add feedback
          {hasDiff ? " · + green / - red" : ""}
        </Text>
      </Box>
    </Box>
  );
}
