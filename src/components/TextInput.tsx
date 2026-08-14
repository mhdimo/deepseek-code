








import React, { useMemo, useRef, useCallback } from "react";
import { Box, Text } from "ink";
import MultilineTextInput from "./MultilineTextInput.js";
import { theme, resolveColor } from "../utils/theme.js";
import { separatorWidth } from "./terminalLayout.js";


interface InputProps {
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
  code: theme.claude,
  plan: theme.warning,
  review: "magenta",
};


function getSuggestion(
  agentName: string,
  cwd: string,
  recentFiles: string[],
): string {
  if (agentName === "plan") {
    return "Try 'analyze the architecture and suggest improvements'";
  }
  if (agentName === "review") {
    return "Try 'review the recent changes for bugs and style issues'";
  }

  const dir = cwd.split("/").filter(Boolean).pop() || "project";

  if (recentFiles.length > 0) {
    const file = recentFiles[0]!;
    const base = file.split("/").filter(Boolean).pop() || file;
    return `Try 'explain ${base}'`;
  }

  const suggestions = [
    `Try 'what does ${dir} do?'`,
    "Try 'find all TODO/FIXME comments'",
    "Try 'show me the project structure'",
    "Try 'what are the main dependencies?'",
    "Try 'what could be improved here?'",
    "Try 'add error handling to the entry point'",
  ];

  const idx = cwd.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % suggestions.length;
  return suggestions[idx]!;
}

export default function Input({
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
  const color = AGENT_COLORS[agentName] || theme.claude;

  
  
  
  
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const stableOnSubmit = useCallback(() => onSubmitRef.current(), []);

  const suggestion = useMemo(
    () => getSuggestion(agentName, workingDirectory, recentFiles),
    [agentName, workingDirectory, recentFiles],
  );

  const placeholder = isLoading
    ? queueCount > 0
      ? `Type and press Enter to queue… (${queueCount} queued)`
      : "Type and press Enter to queue next message..."
    : suggestion;

  const hasNewlines = value.includes("\n");
  const cols = separatorWidth(process.stdout.columns);
  const cwdBase = workingDirectory.split("/").filter(Boolean).pop() || "";
  const left = cwdBase ? `── ${cwdBase} ` : "──";
  const topDivider = left + "─".repeat(Math.max(0, cols - left.length));
  const bottomDivider = "─".repeat(cols);

  return (
    <Box flexDirection="column" width="100%">
      {}
      <Text color="gray">{topDivider}</Text>

      {}
      <Box flexDirection="row" paddingX={1}>
        <Text bold={!isLoading} dimColor={isLoading} color={resolveColor(color)}>
          {isLoading ? "⏳ " : "❯ "}
        </Text>
        <MultilineTextInput
          value={value}
          onChange={onChange}
          onSubmit={stableOnSubmit}
          focus={!isBlocked}
          placeholder={placeholder}
          isPickerActive={isPickerActive}
        />
      </Box>

      {}
      <Text color="gray">{bottomDivider}</Text>

      {}
      {hasNewlines && (
        <Box paddingX={2}>
          <Text dimColor>enter to submit · alt+enter for newline</Text>
        </Box>
      )}
    </Box>
  );
}
