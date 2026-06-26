// Input component — bordered input matching Claude Code's prompt area
//
// Layout:
// ╭──────────────────────────────────────────────────────╮
// │ ❯ Type a message... (tab)                           │
// ╰──────────────────────────────────────────────────────╯
// Enter submit · Esc interrupt · ↑ history · Tab suggest

import React, { useMemo } from "react";
import { Box, Text, useInput } from "ink";
import MultilineTextInput from "./MultilineTextInput.js";
import { theme } from "../utils/theme.js";

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
  isPickerActive?: boolean;
}

const AGENT_COLORS: Record<string, string> = {
  code: theme.assistant,
  plan: theme.warning,
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
  isPickerActive = false,
}: InputProps) {
  const color = AGENT_COLORS[agentName] || theme.assistant;

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

  const hasNewlines = value.includes("\n");

  // Build footer hints
  const hints: string[] = [];
  if (hasNewlines) hints.push("Enter submit");
  if (hasNewlines) hints.push("Alt+Enter newline");
  if (isLoading) hints.push("Esc interrupt");
  if (!isLoading && !hasNewlines) hints.push("Enter submit");
  if (!isLoading) hints.push("↑↓ history");
  if (waitingPermission) {
    hints.length = 0;
    hints.push("Enter confirm", "Esc cancel");
  }

  return (
    <Box flexDirection="column">
      {/* Bordered input area matching Claude Code's full-width horizontal bar */}
      <Box
        flexDirection="row"
        alignItems="flex-start"
        justifyContent="flex-start"
        borderColor={color}
        borderStyle="round"
        borderLeft={false}
        borderRight={false}
        borderBottom={true}
        borderTop={true}
        width="100%"
        paddingX={1}
      >
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
          isPickerActive={isPickerActive}
        />
      </Box>

      {/* Footer hints */}
      {hints.length > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>
            {hints.map((h, i) => (
              <React.Fragment key={i}>
                {i > 0 && " · "}
                <Text bold>{h}</Text>
              </React.Fragment>
            ))}
          </Text>
        </Box>
      )}
    </Box>
  );
}
