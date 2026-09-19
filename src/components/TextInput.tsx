








import React, { useMemo, useRef, useCallback } from "react";
import { Box, Text } from "ink";
import MultilineTextInput from "./MultilineTextInput.js";
import { theme, resolveColor } from "../utils/theme.js";


interface InputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isLoading: boolean;
  workingDirectory?: string;
  recentFiles?: string[];
  isBlocked?: boolean;
  waitingPermission?: boolean;
  queueCount?: number;
  isPickerActive?: boolean;
}

/**
 * The reference's example commands, in its order. The four slots that name a
 * file take the basename of one of the project's most-edited files; the
 * reference interpolates a literal `<filepath>` when it has none cached.
 */
export function exampleCommands(frequentFile: string): string[] {
  return [
    "fix lint errors",
    "fix typecheck errors",
    `how does ${frequentFile} work?`,
    `refactor ${frequentFile}`,
    "how do I log an error?",
    `edit ${frequentFile} to...`,
    `write a test for ${frequentFile}`,
    "create a util logging.py that...",
  ];
}

export function getSuggestion(cwd: string, recentFiles: string[] = []): string {
  // The reference wraps the example in double quotes: Try "<example>". It
  // samples one at random and memoizes for the process; hashing the cwd keeps
  // the prompt from reshuffling under the user from one launch to the next.
  const file = recentFiles[0];
  const frequentFile = file
    ? file.split("/").filter(Boolean).pop() || file
    : "<filepath>";
  const examples = exampleCommands(frequentFile);

  const idx = cwd.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % examples.length;
  return `Try "${examples[idx]!}"`;
}

export default function Input({
  value,
  onChange,
  onSubmit,
  isLoading,
  workingDirectory = "",
  recentFiles = [],
  isBlocked = false,
  waitingPermission = false,
  queueCount = 0,
  isPickerActive = false,
}: InputProps) {
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const stableOnSubmit = useCallback(() => onSubmitRef.current(), []);

  // One example set for every agent: the reference's placeholder does not vary
  // with plan/review mode.
  const suggestion = useMemo(
    () => getSuggestion(workingDirectory, recentFiles),
    [workingDirectory, recentFiles],
  );

  // The input's loading state never changes the placeholder: Claude Code keeps
  // the same text and only swaps in the queue hint once something is queued.
  const placeholder =
    queueCount > 0 ? "Press up to edit queued messages" : suggestion;

  return (
    <Box flexDirection="column" width="100%">
      {}
      {waitingPermission && (
        <Box marginTop={1} marginLeft={2}>
          <Text dimColor>Waiting for permission…</Text>
        </Box>
      )}

      {/* The prompt row's rules are the row's own border, as in the reference:
          round, with the left and right edges striped off, so it prints a
          plain full-width `─` line above the input and another below it, both
          in the promptBorder token. Hand-rolled lines bypass the themed border
          and carry whatever the caller prints into them — the reference writes
          nothing but the fast-mode icon into its top rule, never the cwd. */}
      <Box
        flexDirection="row"
        alignItems="flex-start"
        justifyContent="flex-start"
        borderStyle="round"
        borderLeft={false}
        borderRight={false}
        borderBottom
        borderColor={resolveColor(theme.promptBorder)}
        width="100%"
      >
        {/* Plain default foreground, never bold — the glyph dims while a
            query runs. The trailing space is a non-breaking one (U+00A0),
            as in the reference. */}
        <Text dimColor={isLoading}>{"❯\u00a0"}</Text>
        <MultilineTextInput
          value={value}
          onChange={onChange}
          onSubmit={stableOnSubmit}
          focus={!isBlocked}
          placeholder={placeholder}
          isPickerActive={isPickerActive}
        />
      </Box>
    </Box>
  );
}
