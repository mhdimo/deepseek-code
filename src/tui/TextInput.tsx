// Input component with multiline support
// Enter submits, Alt+Enter / Ctrl+J inserts newline

import React, { useMemo } from "react";
import { Box, Text, useInput } from "ink";
import MultilineTextInput from "./MultilineTextInput.js";

interface InputProps {
  inputResetKey?: number;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isLoading: boolean;
  agentName: string;
  workingDirectory?: string;
  recentFiles?: string[];
  isBlocked?: boolean;
  waitingPermission?: boolean;
  queueCount?: number;
}

const AGENT_COLORS: Record<string, string> = {
  code: "cyan",
  plan: "yellow",
  review: "magenta",
};

/** Context-aware placeholder suggestions */
function getSuggestion(
  agentName: string,
  cwd: string,
  recentFiles: string[],
): string {
  if (agentName === "plan") {
    return "analyze the architecture and suggest improvements";
  }
  if (agentName === "review") {
    return "review the recent changes for bugs and style issues";
  }

  const dir = cwd.split("/").filter(Boolean).pop() || "project";

  if (recentFiles.length > 0) {
    const file = recentFiles[0]!;
    const base = file.split("/").filter(Boolean).pop() || file;
    return `explain ${base}`;
  }

  const suggestions = [
    `what does ${dir} do?`,
    "find all TODO/FIXME comments",
    "show me the project structure",
    "what are the main dependencies?",
    "what could be improved here?",
    "add error handling to the entry point",
  ];

  const idx = cwd.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % suggestions.length;
  return suggestions[idx]!;
}

/** Context-sensitive footer hints */
function FooterHints({
  value,
  isLoading,
  waitingPermission,
}: {
  value: string;
  isLoading: boolean;
  waitingPermission: boolean;
}) {
  const hasNewlines = value.includes("\n");

  // Loading without multiline: existing behavior
  if (isLoading && !hasNewlines) {
    return (
      <Text dimColor italic>
        {waitingPermission
          ? "Waiting for permission approval\u2026 Enter confirms selected action, Esc cancels."
          : "Running response\u2026 press Esc to interrupt."}
      </Text>
    );
  }

  // Multiline hints
  const hints: string[] = [];
  if (hasNewlines) {
    hints.push("Enter submit");
    hints.push("Alt+Enter / Ctrl+J newline");
  }
  if (isLoading) {
    hints.push("Esc interrupt");
  }

  if (hints.length === 0) return null;

  return (
    <Text dimColor>
      {hints.map((h, i) => (
        <React.Fragment key={i}>
          {i > 0 && " \u00b7 "}
          <Text bold>{h}</Text>
        </React.Fragment>
      ))}
    </Text>
  );
}

export default function Input({
  inputResetKey,
  value,
  onChange,
  onSubmit,
  isLoading,
  agentName,
  workingDirectory = "",
  recentFiles = [],
  isBlocked = false,
  waitingPermission = false,
  queueCount = 0,
}: InputProps) {
  const color = AGENT_COLORS[agentName] || "cyan";

  const suggestion = useMemo(
    () => getSuggestion(agentName, workingDirectory, recentFiles),
    [agentName, workingDirectory, recentFiles],
  );

  // Tab to autocomplete the suggestion when input is empty
  useInput((_input, key) => {
    if (key.tab && value === "" && !isLoading) {
      onChange(suggestion);
    }
  }, { isActive: !isBlocked });

  const placeholder = isLoading
    ? queueCount > 0
      ? `Type and press Enter to queue… (${queueCount} queued)`
      : "Type and press Enter to queue next message..."
    : `${suggestion} (tab)`;

  return (
    <Box flexDirection="column" paddingX={0}>
      <Box>
        <Text bold={!isLoading} dimColor={isLoading} color={color}>
          {"❯ "}
        </Text>
        <MultilineTextInput
          key={inputResetKey}
          value={value}
          onChange={onChange}
          onSubmit={() => onSubmit()}
          focus={!isBlocked}
          placeholder={placeholder}
        />
      </Box>
      <FooterHints
        value={value}
        isLoading={isLoading}
        waitingPermission={waitingPermission}
      />
    </Box>
  );
}
