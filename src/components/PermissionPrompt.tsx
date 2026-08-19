/**
 * Permission dialogs (port of Claude Code's components/permissions/).
 *
 * The default export dispatches on toolName:
 *   - Edit            → FileEditPermissionRequest  (diff preview + file dialog)
 *   - Write           → FileWritePermissionRequest (old-vs-new diff + file dialog)
 *   - Bash/PowerShell → ShellPermissionRequest (with an editable "don't ask
 *                        again for <command prefix>" rule option)
 *   - FileRead/Glob/Grep → read-only file dialogs ("Allow read access to …?")
 *   - NotebookEdit    → notebook edit dialog
 *   - WebFetch        → domain-scoped dialog ("don't ask again for <host>")
 *   - Skill           → skill dialog with exact/prefix rule options
 *   - Enter/ExitPlanMode → plan-mode explanation dialog
 *   - AskUserQuestion → answer-the-question dialog
 *   - anything else   → FallbackPermissionRequest ("Tool use")
 *
 * Shared machinery: PermissionDialog (round-bordered header frame with title
 * + subtitle), PermissionRequestTitle, usePermissionFeedback (accept/reject
 * feedback input state + free-form "input" options like the bash prefix),
 * PermissionSelect (keyboard-selectable option list with inline feedback
 * input; Tab toggles the input mode for the focused Yes/No option), and
 * useRuleExplanation (threads a matched permission-rule decision into the
 * dialog as a dim explanation line).
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, sep } from "path";
import { readFileSync, realpathSync } from "fs";
import { type StructuredPatchHunk } from "diff";
import { getTheme, resolveColor } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";
import {
  DASHED_BORDER,
  DiffFrame,
  StructuredDiffList,
} from "./StructuredDiff.js";
import { getPatchForDisplay, type FileEditSpec } from "../utils/diff.js";
import MultilineTextInput from "./MultilineTextInput.js";
import { isMouseSequence } from "./useMouseWheelScroll.js";
import { loadSettings } from "../state/storage.js";
import {
  clampLines,
  escapeRuleContent,
  isPathInFolder,
  matchDecision,
  parsePermissionSettings,
  pathInWorkingPath,
  permissionRuleExplanation,
  persistAllowRule,
  stripBashRedirections,
  suggestBashPrefix,
} from "../services/permissions.js";

/** Cap on diff rows rendered inside permission dialogs — keeps the dialog
 *  from overflowing the terminal. StructuredDiffList truncates to this, and
 *  FileWriteToolDiff's plain-content branch caps at the same value. */
const MAX_DIFF_ROWS = 12;

interface PermissionPromptProps {
  toolName: string;
  description: string | (() => string);
  input?: unknown;
  workingDir: string;
  /** Pre-computed reason the prompt was raised (e.g. a hook decision).
   *  When absent, the matched persisted permission rule is derived from the
   *  permission engine and rendered instead. */
  explanation?: string;
  isTranscriptMode?: boolean; // accepted for App compatibility; unused here
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}

type FeedbackType = "accept" | "reject" | "input";

/** Base permission option (before usePermissionFeedback transforms it). */
interface PermissionOption {
  label: React.ReactNode;
  value: string;
  feedbackType?: FeedbackType;
  placeholder?: string;
  /** Seed value for `feedbackType: "input"` options (e.g. the bash prefix). */
  initialInputValue?: string;
  /** Render the label inline before the input row (e.g. "…don't ask again for: npm run:*"). */
  showLabel?: boolean;
  description?: string;
  dimDescription?: boolean;
}

/** Select-compatible option: plain text row or inline feedback input row. */
type SelectOption =
  | {
      type: "text";
      label: React.ReactNode;
      value: string;
      description?: string;
      dimDescription?: boolean;
    }
  | {
      type: "input";
      label: React.ReactNode;
      value: string;
      inputValue: string;
      onChange: (value: string) => void;
      placeholder?: string;
      allowEmptySubmitToCancel?: boolean;
      showLabel?: boolean;
      description?: string;
      dimDescription?: boolean;
    };

const DEFAULT_PLACEHOLDERS: Record<FeedbackType, string> = {
  accept: "and tell me what to do next",
  reject: "and tell me what to do differently",
  input: "",
};

/** Resolve a tool-input path against the working directory. */
function resolvePath(filePath: string, workingDir: string): string {
  if (isAbsolute(filePath)) return filePath;
  if (filePath.startsWith("~")) return join(homedir(), filePath.slice(1));
  return join(workingDir, filePath);
}

function inputString(input: unknown, key: string): string {
  if (input == null || typeof input !== "object") return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function inputBool(input: unknown, key: string): boolean {
  if (input == null || typeof input !== "object") return false;
  return Boolean((input as Record<string, unknown>)[key]);
}

/* ------------------------------------------------------------------ */
/* PermissionDialog                                                    */
/* ------------------------------------------------------------------ */

function PermissionDialog({
  title,
  subtitle,
  titleRight,
  innerPaddingX = 1,
  explanation,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  titleRight?: React.ReactNode;
  innerPaddingX?: number;
  /** Dim reason line — why this prompt appeared (matched rule / hook). */
  explanation?: string | null;
  children?: React.ReactNode;
}) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={resolveColor(theme.permission)}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      marginTop={1}
      flexShrink={0}
    >
      <Box paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <PermissionRequestTitle title={title} subtitle={subtitle} />
          {titleRight}
        </Box>
      </Box>
      {explanation != null && (
        <Box paddingX={1} paddingY={1} flexShrink={0}>
          <Text dimColor>{explanation}</Text>
        </Box>
      )}
      <Box flexDirection="column" paddingX={innerPaddingX}>
        {children}
      </Box>
    </Box>
  );
}

function PermissionRequestTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: React.ReactNode;
}) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold color={resolveColor(theme.permission)}>
          {title}
        </Text>
      </Box>
      {subtitle != null &&
        (typeof subtitle === "string" ? (
          <Text dimColor wrap="truncate-start">
            {subtitle}
          </Text>
        ) : (
          subtitle
        ))}
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* usePermissionFeedback                                               */
/* ------------------------------------------------------------------ */

function usePermissionFeedback(options: PermissionOption[], initialFocus?: string) {
  const [acceptFeedback, setAcceptFeedback] = useState("");
  const [rejectFeedback, setRejectFeedback] = useState("");
  const [acceptInputMode, setAcceptInputMode] = useState(false);
  const [rejectInputMode, setRejectInputMode] = useState(false);
  // Free-form "input" options (e.g. the editable bash prefix) keyed by value.
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [focusedValue, setFocusedValue] = useState<string | null>(
    initialFocus ?? null,
  );

  const getInputValue = (value: string): string => inputValues[value] ?? "";

  // Transform base options into Select-compatible options; feedback-enabled
  // options become input rows while their input mode is active. "input"
  // options are always input rows, seeded from `initialInputValue`.
  const selectOptions = useMemo<SelectOption[]>(() => {
    return options.map((option) => {
      const {
        label,
        value,
        feedbackType,
        placeholder,
        initialInputValue,
        showLabel,
        description,
        dimDescription,
      } = option;

      if (feedbackType == null) {
        return { type: "text", label, value, description, dimDescription };
      }

      const isInputMode =
        feedbackType === "accept"
          ? acceptInputMode
          : feedbackType === "reject"
            ? rejectInputMode
            : true;

      if (isInputMode) {
        return {
          type: "input",
          label,
          value,
          placeholder:
            placeholder ??
            (feedbackType === "input" ? "" : DEFAULT_PLACEHOLDERS[feedbackType]),
          inputValue:
            feedbackType === "accept"
              ? acceptFeedback
              : feedbackType === "reject"
                ? rejectFeedback
                : inputValues[value] ?? initialInputValue ?? "",
          onChange:
            feedbackType === "accept"
              ? setAcceptFeedback
              : feedbackType === "reject"
                ? setRejectFeedback
                : (v: string) =>
                    setInputValues((prev) => ({ ...prev, [value]: v })),
          allowEmptySubmitToCancel: true,
          showLabel,
          description,
          dimDescription,
        };
      }

      return { type: "text", label, value, description, dimDescription };
    });
  }, [
    options,
    acceptInputMode,
    rejectInputMode,
    acceptFeedback,
    rejectFeedback,
    inputValues,
  ]);

  const handleInputModeToggle = (value: string) => {
    const option = options.find((o) => o.value === value);
    if (option?.feedbackType === "accept") {
      setAcceptInputMode((prev) => !prev);
    } else if (option?.feedbackType === "reject") {
      setRejectInputMode((prev) => !prev);
    }
    // "input" options are always in input mode — nothing to toggle.
  };

  // When navigating away from an option whose input mode is on AND its
  // feedback is empty, collapse that input mode.
  const handleFocusChange = (value: string) => {
    const newOption = options.find((o) => o.value === value);
    if (newOption?.feedbackType !== "accept" && acceptInputMode && acceptFeedback.trim() === "") {
      setAcceptInputMode(false);
    }
    if (newOption?.feedbackType !== "reject" && rejectInputMode && rejectFeedback.trim() === "") {
      setRejectInputMode(false);
    }
    setFocusedValue(value);
  };

  const focusedOption = options.find((o) => o.value === focusedValue);
  const showTabHint =
    (focusedOption?.feedbackType === "accept" && !acceptInputMode) ||
    (focusedOption?.feedbackType === "reject" && !rejectInputMode);

  const getFeedbackFor = (value: string): string | undefined => {
    const option = options.find((o) => o.value === value);
    if (option?.feedbackType == null) return undefined;
    const raw = option.feedbackType === "accept" ? acceptFeedback : rejectFeedback;
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  };

  return {
    selectOptions,
    handleInputModeToggle,
    handleFocusChange,
    showTabHint,
    getFeedbackFor,
    getInputValue,
    focusedValue,
  };
}

/* ------------------------------------------------------------------ */
/* PermissionSelect                                                    */
/* ------------------------------------------------------------------ */

function PermissionSelect({
  options,
  initialFocus,
  onSelect,
  onCancel,
  onFocusChange,
  onInputModeToggle,
}: {
  options: SelectOption[];
  initialFocus?: string;
  onSelect: (value: string) => void;
  onCancel: () => void;
  onFocusChange?: (value: string) => void;
  onInputModeToggle: (value: string) => void;
}) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  const [focusedValue, setFocusedValue] = useState<string>(
    initialFocus ?? options[0]?.value ?? "",
  );

  const focusedIndex = options.findIndex((option) => option.value === focusedValue);
  const safeFocusedIndex = focusedIndex === -1 ? 0 : focusedIndex;
  const focusedOption = options[safeFocusedIndex] ?? null;
  const isInInput = focusedOption?.type === "input";

  // Notify the parent of the initial focus (the reference Select fires
  // onFocus once the initial focus settles).
  useEffect(() => {
    onFocusChange?.(focusedValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusOption = (value: string) => {
    setFocusedValue(value);
    onFocusChange?.(value);
  };

  const focusNext = () => {
    const next = options[(safeFocusedIndex + 1) % options.length];
    if (next) focusOption(next.value);
  };

  const focusPrevious = () => {
    const previous = options[(safeFocusedIndex - 1 + options.length) % options.length];
    if (previous) focusOption(previous.value);
  };

  useInput((input, key) => {
    // Terminal mouse click/drag/wheel sequences must never act as keys.
    if (isMouseSequence(input)) return;

    // Tab toggles the feedback input mode for the focused option — always,
    // in both select mode and input mode.
    if (key.tab) {
      if (focusedOption) onInputModeToggle(focusedOption.value);
      return;
    }

    if (isInInput && focusedOption && focusedOption.type === "input") {
      // Input mode: arrows still navigate; everything else falls through to
      // the MultilineTextInput (Enter submits, digits/j/k type into it).
      if (key.downArrow || (key.ctrl && input === "n")) {
        focusNext();
        return;
      }
      if (key.upArrow || (key.ctrl && input === "p")) {
        focusPrevious();
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      return;
    }

    // Select mode
    if (
      key.downArrow ||
      (key.ctrl && input === "n") ||
      (input === "j" && !key.ctrl && !key.meta)
    ) {
      focusNext();
      return;
    }
    if (
      key.upArrow ||
      (key.ctrl && input === "p") ||
      (input === "k" && !key.ctrl && !key.meta)
    ) {
      focusPrevious();
      return;
    }
    if (key.return) {
      if (focusedOption) onSelect(focusedOption.value);
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (/^[0-9]+$/.test(input)) {
      const index = parseInt(input, 10) - 1;
      const selectedOption = options[index];
      if (selectedOption) {
        if (selectedOption.type === "input") {
          if (selectedOption.inputValue.trim() || selectedOption.allowEmptySubmitToCancel) {
            // Pre-filled input: submit (user can Tab to edit instead).
            onSelect(selectedOption.value);
          } else {
            focusOption(selectedOption.value);
          }
        } else {
          onSelect(selectedOption.value);
        }
      }
      return;
    }
  });

  const maxIndexWidth = options.length.toString().length;

  return (
    <Box flexDirection="column">
      {options.map((option, index) => {
        if (option.type === "input") {
          const isFocused = option.value === focusedValue;
          return (
            <Box key={option.value} flexDirection="column" flexShrink={0}>
              <Box flexDirection="row" flexShrink={0}>
                <Text dimColor>{`${index + 1}.`.padEnd(maxIndexWidth + 2)}</Text>
                {option.showLabel && typeof option.label === "string" ? (
                  <Text dimColor={false}>{`${option.label}: `}</Text>
                ) : null}
                {isFocused ? (
                  <MultilineTextInput
                    value={option.inputValue}
                    onChange={option.onChange}
                    onSubmit={() => {
                      if (option.inputValue.trim() || option.allowEmptySubmitToCancel) {
                        onSelect(option.value);
                      } else {
                        onCancel();
                      }
                    }}
                    focus={isFocused}
                    placeholder={option.placeholder}
                  />
                ) : (
                  <Text color={option.inputValue ? undefined : resolveColor(theme.inactive)}>
                    {option.inputValue ||
                      option.placeholder ||
                      (typeof option.label === "string" ? option.label : "")}
                  </Text>
                )}
              </Box>
              {option.description && (
                <Box paddingLeft={maxIndexWidth + 3}>
                  <Text dimColor={option.dimDescription !== false}>{option.description}</Text>
                </Box>
              )}
            </Box>
          );
        }

        const isFocused = option.value === focusedValue;
        return (
          <Box key={option.value} flexDirection="column" flexShrink={0}>
            <Box flexDirection="row" gap={1}>
              {isFocused ? (
                <Text color={resolveColor(theme.suggestion)}>❯</Text>
              ) : (
                <Text> </Text>
              )}
              <Text dimColor={false} color={isFocused ? resolveColor(theme.suggestion) : undefined}>
                {option.label}
              </Text>
            </Box>
            {option.description && (
              <Box paddingLeft={2}>
                <Text dimColor={option.dimDescription !== false}>{option.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* FilePermissionDialog + options                                      */
/* ------------------------------------------------------------------ */

function getFilePermissionOptions({
  filePath,
  workingDir,
  operationType = "write",
}: {
  filePath: string;
  workingDir: string;
  operationType?: "read" | "write";
}): { options: PermissionOption[]; claudeDir: string | null } {
  const resolvedPath = resolvePath(filePath, workingDir);
  const projectClaudeDir = join(workingDir, ".claude");
  const globalClaudeDir = join(homedir(), ".claude");

  // .claude detection is case-insensitive — macOS/Windows filesystems are
  // case-insensitive, so `.CLAUDE/Settings.json` is still the settings dir.
  let claudeDir: string | null = null;
  if (isPathInFolder(resolvedPath, projectClaudeDir)) {
    claudeDir = projectClaudeDir;
  } else if (isPathInFolder(resolvedPath, globalClaudeDir)) {
    claudeDir = globalClaudeDir;
  }

  // The settings-scope option is a write concern; reads never get it.
  if (claudeDir && operationType !== "read") {
    return {
      options: [
        { label: "Yes", value: "yes", feedbackType: "accept" },
        {
          label: "Yes, and allow DeepSeek Code to edit its own settings for this session",
          value: "yes-claude-folder",
        },
        { label: "No", value: "no", feedbackType: "reject" },
      ],
      claudeDir,
    };
  }

  // Session-scoped option: in-cwd paths get a plain cwd-scope label, paths
  // outside the working directory name their directory so the scope is clear.
  const inCwd = pathInWorkingPath(resolvedPath, workingDir);
  let sessionLabel: React.ReactNode;
  if (inCwd) {
    sessionLabel =
      operationType === "read" ? (
        "Yes, during this session"
      ) : (
        <Text>
          Yes, allow all edits in <Text bold>./</Text> during this session
        </Text>
      );
  } else {
    const dirName = basename(dirname(filePath)) || "this directory";
    sessionLabel =
      operationType === "read" ? (
        <Text>
          Yes, allow reading from <Text bold>{dirName}/</Text> during this session
        </Text>
      ) : (
        <Text>
          Yes, allow all edits in <Text bold>{dirName}/</Text> during this session
        </Text>
      );
  }

  return {
    options: [
      { label: "Yes", value: "yes", feedbackType: "accept" },
      { label: sessionLabel, value: "yes-session" },
      { label: "No", value: "no", feedbackType: "reject" },
    ],
    claudeDir: null,
  };
}

/** Dim explanation line for the prompt: a matched persisted permission rule
 *  (derived via the permission engine) or a pre-computed reason (e.g. a hook
 *  decision) supplied by the caller. */
function useRuleExplanation(
  toolName: string,
  input: unknown,
  workingDir: string,
  explanation?: string,
): string | undefined {
  return useMemo(() => {
    if (explanation) return explanation;
    try {
      const perms = loadSettings().permissions;
      if (!perms) return undefined;
      const decision = matchDecision(
        parsePermissionSettings(perms),
        toolName,
        input ?? {},
        workingDir,
      );
      return permissionRuleExplanation(decision) ?? undefined;
    } catch {
      return undefined;
    }
  }, [explanation, toolName, input, workingDir]);
}

function FilePermissionDialog({
  filePath,
  title,
  subtitle,
  question,
  content,
  operationType = "write",
  explanation,
  workingDir,
  onApprove,
  onDeny,
}: {
  filePath: string;
  title: string;
  subtitle?: React.ReactNode;
  question: string | React.ReactNode;
  content?: React.ReactNode;
  operationType?: "read" | "write";
  explanation?: string;
  workingDir: string;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  const { options, claudeDir } = useMemo(
    () => getFilePermissionOptions({ filePath, workingDir, operationType }),
    [filePath, workingDir, operationType],
  );

  const feedback = usePermissionFeedback(options, options[0]?.value);

  // Warn when the path traverses a symlink anywhere in its parent chain (not
  // just when the final component is one) — and especially when the resolved
  // target lands outside the working directory. The whole chain is realpath'd
  // so `cwd/linkdir/file` where `linkdir -> /elsewhere` still warns.
  const symlinkTarget = useMemo(() => {
    if (!filePath || operationType === "read") return null;
    try {
      const resolved = resolvePath(filePath, workingDir);
      let realTarget: string;
      try {
        realTarget = realpathSync(resolved);
      } catch {
        // Target doesn't exist yet (create) — resolve the deepest existing
        // ancestor chain instead of giving up.
        realTarget = join(realpathSync(dirname(resolved)), basename(resolved));
      }
      return realTarget === resolved ? null : realTarget;
    } catch {
      return null;
    }
  }, [filePath, operationType, workingDir]);

  // Compare against the REAL working directory so macOS /var -> /private/var
  // style links don't trip the "outside working directory" warning.
  const realCwd = useMemo(() => {
    try {
      return realpathSync(workingDir);
    } catch {
      return workingDir;
    }
  }, [workingDir]);

  const isSymlinkOutsideCwd =
    symlinkTarget != null && relative(realCwd, symlinkTarget).startsWith("..");

  const symlinkWarning = symlinkTarget ? (
    <Box paddingX={1} marginBottom={1}>
      <Text color={resolveColor(theme.warning)}>
        {isSymlinkOutsideCwd
          ? `This will modify ${symlinkTarget} (outside working directory) via a symlink`
          : `Symlink target: ${symlinkTarget}`}
      </Text>
    </Box>
  ) : null;

  const handleSelect = (value: string) => {
    if (value === "yes") {
      onApprove(undefined, feedback.getFeedbackFor("yes"));
    } else if (value === "yes-session") {
      onApprove(operationType === "read" ? "__allow_reads__" : "__allow_edits__");
    } else if (value === "yes-claude-folder") {
      onApprove(`__allow_claude_folder__:${claudeDir ?? ""}`);
    } else if (value === "no") {
      onDeny(feedback.getFeedbackFor("no"));
    }
  };

  return (
    <>
      <PermissionDialog
        title={title}
        subtitle={subtitle}
        innerPaddingX={0}
        explanation={explanation}
      >
        {symlinkWarning}
        {content}
        <Box flexDirection="column" paddingX={1}>
          {typeof question === "string" ? <Text>{question}</Text> : question}
          <PermissionSelect
            options={feedback.selectOptions}
            initialFocus={feedback.selectOptions[0]?.value}
            onSelect={handleSelect}
            onCancel={() => onDeny()}
            onFocusChange={feedback.handleFocusChange}
            onInputModeToggle={feedback.handleInputModeToggle}
          />
        </Box>
      </PermissionDialog>
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>
          Esc to cancel
          {feedback.showTabHint && " · Tab to amend"}
        </Text>
      </Box>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Diff views (FileEditToolDiff / FileWriteToolDiff)                   */
/* ------------------------------------------------------------------ */

// Claude Code can't output curly quotes, so we define them as constants here
// for use in the code. We do this because we normalize curly quotes to
// straight quotes when applying edits.
const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";

/**
 * Normalizes quotes in a string by converting curly quotes to straight quotes.
 */
function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

/**
 * Finds the actual string in the file content that matches the search string,
 * accounting for quote normalization.
 */
function findActualString(fileContent: string, searchString: string): string | null {
  // First try exact match
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  // Try with normalized quotes
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);

  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex !== -1) {
    // Find the actual string in the file that matches
    return fileContent.substring(searchIndex, searchIndex + searchString.length);
  }

  return null;
}

/**
 * When old_string matched via quote normalization (curly quotes in file,
 * straight quotes from the model), apply the same curly quote style to
 * new_string so the edit preserves the file's typography.
 */
function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  // If they're the same, no normalization happened
  if (oldString === actualOldString) {
    return newString;
  }

  // Detect which curly quote types were in the file
  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);

  if (!hasDoubleQuotes && !hasSingleQuotes) {
    return newString;
  }

  let result = newString;

  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result);
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result);
  }

  return result;
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) {
    return true;
  }
  const prev = chars[index - 1];
  return (
    prev === " " ||
    prev === "\t" ||
    prev === "\n" ||
    prev === "\r" ||
    prev === "(" ||
    prev === "[" ||
    prev === "{" ||
    prev === "—" || // em dash
    prev === "–" // en dash
  );
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(
        isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE,
      );
    } else {
      result.push(chars[i]!);
    }
  }
  return result.join("");
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      // Don't convert apostrophes in contractions (e.g., "don't", "it's").
      // An apostrophe between two letters is a contraction, not a quote.
      const prev = i > 0 ? chars[i - 1] : undefined;
      const next = i < chars.length - 1 ? chars[i + 1] : undefined;
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev);
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next);
      if (prevIsLetter && nextIsLetter) {
        // Apostrophe in a contraction — use right single curly quote
        result.push(RIGHT_SINGLE_CURLY_QUOTE);
      } else {
        result.push(
          isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE,
        );
      }
    } else {
      result.push(chars[i]!);
    }
  }
  return result.join("");
}

// A needle at or above CHUNK_SIZE means the whole file was passed as
// old_string (e.g. a full-file rewrite) — skip the file read entirely.
const CHUNK_SIZE = 8 * 1024;

interface DiffData {
  patch: StructuredPatchHunk[];
}

function normalizeEdit(fileContent: string, edit: FileEditSpec): FileEditSpec {
  const actualOld = findActualString(fileContent, edit.old_string) || edit.old_string;
  const actualNew = preserveQuoteStyle(edit.old_string, actualOld, edit.new_string);
  return { ...edit, old_string: actualOld, new_string: actualNew };
}

function diffToolInputsOnly(filePath: string, edits: FileEditSpec[]): DiffData {
  return {
    patch: edits.flatMap((edit) =>
      getPatchForDisplay({
        filePath,
        fileContents: edit.old_string,
        edits: [edit],
      }),
    ),
  };
}

function loadDiffData({
  file_path,
  edits,
  workingDir,
}: {
  file_path: string;
  edits: FileEditSpec[];
  workingDir: string;
}): DiffData {
  const valid = edits.filter(
    (edit) => edit.old_string != null && edit.new_string != null,
  );
  const single = valid.length === 1 ? valid[0] : undefined;

  // A needle at or above CHUNK_SIZE means the whole file was passed as
  // old_string (e.g. a full-file rewrite) — diff the inputs we already have
  // instead of reading the file.
  if (single && single.old_string.length >= CHUNK_SIZE) {
    return diffToolInputsOnly(file_path, [single]);
  }

  try {
    const file = readFileSync(resolvePath(file_path, workingDir), "utf-8");
    const normalized = valid.map((edit) => normalizeEdit(file, edit));
    return {
      patch: getPatchForDisplay({
        filePath: file_path,
        fileContents: file,
        edits: normalized,
      }),
    };
  } catch {
    return diffToolInputsOnly(file_path, valid);
  }
}

function FileEditToolDiff({
  file_path,
  edits,
  workingDir,
}: {
  file_path: string;
  edits: FileEditSpec[];
  workingDir: string;
}) {
  // Snapshot on mount — the diff must stay consistent even if the file
  // changes while the dialog is open.
  const [data] = useState(() => loadDiffData({ file_path, edits, workingDir }));
  const columns = process.stdout.columns || 80;

  return (
    <DiffFrame>
      <StructuredDiffList
        hunks={data.patch}
        dim={false}
        width={columns}
        maxRows={MAX_DIFF_ROWS}
      />
    </DiffFrame>
  );
}

function FileWriteToolDiff({
  file_path,
  content,
  fileExists,
  oldContent,
}: {
  file_path: string;
  content: string;
  fileExists: boolean;
  oldContent: string;
}) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  const hunks = useMemo(() => {
    if (!fileExists) return null;
    return getPatchForDisplay({
      filePath: file_path,
      fileContents: oldContent,
      edits: [{ old_string: oldContent, new_string: content, replace_all: false }],
    });
  }, [fileExists, file_path, oldContent, content]);

  const columns = process.stdout.columns || 80;

  return (
    <Box flexDirection="column">
      <Box
        borderColor={resolveColor(theme.subtle)}
        borderStyle={DASHED_BORDER}
        flexDirection="column"
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        {hunks ? (
          <StructuredDiffList
            hunks={hunks}
            dim={false}
            width={columns - 2}
            maxRows={MAX_DIFF_ROWS}
          />
        ) : content ? (
          <Box flexDirection="column">
            <Text>{content.split("\n").slice(0, MAX_DIFF_ROWS).join("\n")}</Text>
            {content.split("\n").length > MAX_DIFF_ROWS && <Text dimColor>…</Text>}
          </Box>
        ) : (
          <Text dimColor>(No content)</Text>
        )}
      </Box>
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* Per-tool permission requests                                        */
/* ------------------------------------------------------------------ */

function FileEditPermissionRequest({
  file_path,
  edits,
  explanation,
  workingDir,
  onApprove,
  onDeny,
}: {
  file_path: string;
  edits: FileEditSpec[];
  explanation?: string;
  workingDir: string;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  return (
    <FilePermissionDialog
      filePath={file_path}
      title="Edit file"
      subtitle={relative(workingDir, file_path)}
      question={
        <Text>
          Do you want to make this edit to <Text bold>{basename(file_path)}</Text>?
        </Text>
      }
      content={<FileEditToolDiff file_path={file_path} edits={edits} workingDir={workingDir} />}
      explanation={explanation}
      workingDir={workingDir}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}

function FileWritePermissionRequest({
  file_path,
  content,
  explanation,
  workingDir,
  onApprove,
  onDeny,
}: {
  file_path: string;
  content: string;
  explanation?: string;
  workingDir: string;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  // Single read drives both the UI text ("Create" vs "Overwrite") and the
  // diff shown by FileWriteToolDiff.
  const [{ fileExists, oldContent }] = useState(() => {
    try {
      return {
        fileExists: true,
        oldContent: readFileSync(resolvePath(file_path, workingDir), "utf-8"),
      };
    } catch {
      return { fileExists: false, oldContent: "" };
    }
  });

  const actionText = fileExists ? "overwrite" : "create";

  return (
    <FilePermissionDialog
      filePath={file_path}
      title={fileExists ? "Overwrite file" : "Create file"}
      subtitle={relative(workingDir, file_path)}
      question={
        <Text>
          Do you want to {actionText} <Text bold>{basename(file_path)}</Text>?
        </Text>
      }
      content={
        <FileWriteToolDiff
          file_path={file_path}
          content={content}
          fileExists={fileExists}
          oldContent={oldContent}
        />
      }
      explanation={explanation}
      workingDir={workingDir}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}

function ShellPermissionRequest({
  toolName,
  command,
  description,
  explanation,
  workingDir,
  onApprove,
  onDeny,
}: {
  toolName: string;
  command: string;
  description: string;
  explanation?: string;
  workingDir: string;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  // "Yes, and don't ask again for <prefix>" — seeded with a suggested stable
  // prefix (redirections stripped, `npm run:*` style), user-editable.
  const suggestedPrefix = useMemo(() => {
    const suggested = suggestBashPrefix(command);
    if (suggested) return `${suggested}:*`;
    const stripped = stripBashRedirections(command);
    return stripped || "";
  }, [command]);

  const options: PermissionOption[] = [
    { label: "Yes", value: "yes", feedbackType: "accept" },
    {
      label: "Yes, and don't ask again for",
      value: "yes-prefix",
      feedbackType: "input",
      placeholder: "command prefix (e.g., npm run:*)",
      initialInputValue: suggestedPrefix,
      showLabel: true,
    },
    { label: "Yes, allow all commands during this session", value: "yes-all" },
    { label: "No", value: "no", feedbackType: "reject" },
  ];
  const feedback = usePermissionFeedback(options, options[0]?.value);

  const handleSelect = (value: string) => {
    if (value === "yes") {
      onApprove(undefined, feedback.getFeedbackFor("yes"));
    } else if (value === "yes-all") {
      onApprove("__allow_all__");
    } else if (value === "yes-prefix") {
      const prefix = feedback.getInputValue("yes-prefix").trim();
      if (prefix) {
        persistAllowRule(`${toolName}(${escapeRuleContent(prefix)})`);
      }
      onApprove();
    } else if (value === "no") {
      onDeny(feedback.getFeedbackFor("no"));
    }
  };

  const title = toolName === "Bash" ? "Bash command" : "PowerShell command";

  return (
    <>
      <PermissionDialog title={title} explanation={explanation}>
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text dimColor>{description}</Text>
        </Box>
        <Box flexDirection="column">
          <Text>Do you want to proceed?</Text>
          <PermissionSelect
            options={feedback.selectOptions}
            initialFocus={feedback.selectOptions[0]?.value}
            onSelect={handleSelect}
            onCancel={() => onDeny()}
            onFocusChange={feedback.handleFocusChange}
            onInputModeToggle={feedback.handleInputModeToggle}
          />
        </Box>
      </PermissionDialog>
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>
          Esc to cancel
          {feedback.showTabHint && " · Tab to amend"}
        </Text>
      </Box>
    </>
  );
}

/** Split a user-facing tool name; a trailing " (MCP)" renders as a dim
 *  suffix so the name itself reads cleanly. */
function splitUserFacingName(toolName: string): {
  name: string;
  mcpSuffix: string | null;
} {
  if (toolName.endsWith(" (MCP)")) {
    return { name: toolName.slice(0, -" (MCP)".length), mcpSuffix: " (MCP)" };
  }
  return { name: toolName, mcpSuffix: null };
}

function FallbackPermissionRequest({
  toolName,
  description,
  explanation,
  workingDir,
  onApprove,
  onDeny,
}: {
  toolName: string;
  description: string;
  explanation?: string;
  workingDir: string;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  const options: PermissionOption[] = [
    { label: "Yes", value: "yes", feedbackType: "accept" },
    {
      label: (
        <Text>
          Yes, and don't ask again for <Text bold>{toolName}</Text> in{" "}
          <Text bold>{workingDir}</Text>
        </Text>
      ),
      value: "yes-dont-ask-again",
    },
    { label: "No", value: "no", feedbackType: "reject" },
  ];
  const feedback = usePermissionFeedback(options, options[0]?.value);

  const { name, mcpSuffix } = splitUserFacingName(toolName);

  // First description line becomes the `ToolName(args)` header; the rest are
  // dim body lines clamped to 3 lines.
  const lines = description.split("\n");
  const firstLine = (lines[0] ?? "").trim();
  const args = firstLine.length > 60 ? `${firstLine.slice(0, 60).trimEnd()}…` : firstLine;
  const shownDescLines = clampLines(lines.slice(1).join("\n"), 3).split("\n");

  const handleSelect = (value: string) => {
    if (value === "yes") {
      onApprove(undefined, feedback.getFeedbackFor("yes"));
    } else if (value === "yes-dont-ask-again") {
      persistAllowRule(toolName);
      onApprove();
    } else if (value === "no") {
      onDeny(feedback.getFeedbackFor("no"));
    }
  };

  return (
    <>
      <PermissionDialog title="Tool use" explanation={explanation}>
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text>
            {name}
            {args ? `(${args})` : ""}
            {mcpSuffix && <Text dimColor>{mcpSuffix}</Text>}
          </Text>
          {shownDescLines.map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text>Do you want to proceed?</Text>
          <PermissionSelect
            options={feedback.selectOptions}
            initialFocus={feedback.selectOptions[0]?.value}
            onSelect={handleSelect}
            onCancel={() => onDeny()}
            onFocusChange={feedback.handleFocusChange}
            onInputModeToggle={feedback.handleInputModeToggle}
          />
        </Box>
      </PermissionDialog>
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>
          Esc to cancel
          {feedback.showTabHint && " · Tab to amend"}
        </Text>
      </Box>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Per-tool wrappers (read files, notebook, WebFetch, Skill, plan, ask) */
/* ------------------------------------------------------------------ */

function ReadFilePermissionRequest({
  file_path,
  explanation,
  workingDir,
  onApprove,
  onDeny,
}: {
  file_path: string;
  explanation?: string;
  workingDir: string;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  return (
    <FilePermissionDialog
      filePath={file_path}
      title="Read file"
      subtitle={relative(workingDir, file_path)}
      question={
        <Text>
          Allow read access to <Text bold>{basename(file_path)}</Text>?
        </Text>
      }
      operationType="read"
      explanation={explanation}
      workingDir={workingDir}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}

function SearchFilesPermissionRequest({
  directory,
  explanation,
  workingDir,
  onApprove,
  onDeny,
}: {
  directory: string;
  explanation?: string;
  workingDir: string;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  return (
    <FilePermissionDialog
      filePath={directory}
      title="Search files"
      subtitle={relative(workingDir, directory)}
      question={
        <Text>
          Allow read access to <Text bold>{directory}</Text>?
        </Text>
      }
      operationType="read"
      explanation={explanation}
      workingDir={workingDir}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}

/** NotebookEdit prompts come without input from the tool; recover the path
 *  from the "NotebookEdit: <op> cell <n> in <path>" description line. */
function parseNotebookPath(description: string, input: unknown): string {
  const fromInput = inputString(input, "notebook_path");
  if (fromInput) return fromInput;
  const firstLine = description.split("\n")[0] ?? "";
  const match = firstLine.match(/in\s+(\S+)$/);
  return match?.[1] ?? "";
}

function NotebookEditPermissionRequest({
  description,
  input,
  explanation,
  workingDir,
  onApprove,
  onDeny,
}: {
  description: string;
  input?: unknown;
  explanation?: string;
  workingDir: string;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  const notebookPath = useMemo(
    () => parseNotebookPath(description, input),
    [description, input],
  );
  if (!notebookPath) {
    return (
      <FallbackPermissionRequest
        toolName="NotebookEdit"
        description={description}
        explanation={explanation}
        workingDir={workingDir}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );
  }
  return (
    <FilePermissionDialog
      filePath={notebookPath}
      title="Edit notebook"
      subtitle={relative(workingDir, notebookPath)}
      question={
        <Text>
          Do you want to edit <Text bold>{basename(notebookPath)}</Text>?
        </Text>
      }
      explanation={explanation}
      workingDir={workingDir}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}

/** Best-effort URL recovery: NotebookEdit-style tools call requestPermission
 *  without input, so the URL lives in the description. */
function extractUrl(input: unknown, description: string): string {
  const fromInput = inputString(input, "url");
  if (fromInput) return fromInput;
  const match = description.match(/https?:\/\/[^\s?]+/);
  return match?.[0] ?? "";
}

function WebFetchPermissionRequest({
  description,
  input,
  explanation,
  workingDir,
  onApprove,
  onDeny,
}: {
  description: string;
  input?: unknown;
  explanation?: string;
  workingDir: string;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  const url = useMemo(() => extractUrl(input, description), [input, description]);
  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Malformed URL — the generic fallback renders the description instead.
  }

  // Hooks-first: build options and feedback unconditionally so hook order is
  // stable even when hostname can't be recovered from the prompt.
  const options: PermissionOption[] = hostname
    ? [
        { label: "Yes", value: "yes", feedbackType: "accept" },
        {
          label: (
            <Text>
              Yes, and don't ask again for <Text bold>{hostname}</Text>
            </Text>
          ),
          value: "yes-dont-ask-again-domain",
        },
        { label: "No", value: "no", feedbackType: "reject" },
      ]
    : [
        { label: "Yes", value: "yes", feedbackType: "accept" },
        { label: "No", value: "no", feedbackType: "reject" },
      ];
  const feedback = usePermissionFeedback(options, options[0]?.value);

  if (!hostname) {
    return (
      <FallbackPermissionRequest
        toolName="WebFetch"
        description={description}
        explanation={explanation}
        workingDir={workingDir}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );
  }

  const handleSelect = (value: string) => {
    if (value === "yes") {
      onApprove(undefined, feedback.getFeedbackFor("yes"));
    } else if (value === "yes-dont-ask-again-domain") {
      persistAllowRule(`WebFetch(domain:${hostname})`);
      onApprove();
    } else if (value === "no") {
      onDeny(feedback.getFeedbackFor("no"));
    }
  };

  return (
    <>
      <PermissionDialog title="Fetch" explanation={explanation}>
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text dimColor>{description}</Text>
        </Box>
        <Box flexDirection="column">
          <Text>Do you want to allow fetching content from {hostname}?</Text>
          <PermissionSelect
            options={feedback.selectOptions}
            initialFocus={feedback.selectOptions[0]?.value}
            onSelect={handleSelect}
            onCancel={() => onDeny()}
            onFocusChange={feedback.handleFocusChange}
            onInputModeToggle={feedback.handleInputModeToggle}
          />
        </Box>
      </PermissionDialog>
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>
          Esc to cancel
          {feedback.showTabHint && " · Tab to amend"}
        </Text>
      </Box>
    </>
  );
}

function SkillPermissionRequest({
  description,
  input,
  explanation,
  workingDir,
  onApprove,
  onDeny,
}: {
  description: string;
  input?: unknown;
  explanation?: string;
  workingDir: string;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  // SkillTool's input carries `name`; fall back to the prompt text
  // ("Run the skill <name>…") when input is absent (e.g. hook-raised).
  const skillName = useMemo(() => {
    const fromInput = inputString(input, "name");
    if (fromInput) return fromInput;
    const afterKeyword = description.match(/\bskill\s+["']?([\w-]+(?:\s+[\w-]+)*)/i);
    if (afterKeyword?.[1]) return afterKeyword[1].trim();
    const quoted = description.match(/["']([^"']+)["']/);
    if (quoted?.[1]) return quoted[1].trim();
    return description.trim() || "Skill";
  }, [description, input]);

  const options: PermissionOption[] = [
    { label: "Yes", value: "yes", feedbackType: "accept" },
    {
      label: (
        <Text>
          Yes, and don't ask again for <Text bold>{skillName}</Text> in{" "}
          <Text bold>{workingDir}</Text>
        </Text>
      ),
      value: "yes-exact",
    },
    { label: "No", value: "no", feedbackType: "reject" },
  ];
  const feedback = usePermissionFeedback(options, options[0]?.value);

  const handleSelect = (value: string) => {
    if (value === "yes") {
      onApprove(undefined, feedback.getFeedbackFor("yes"));
    } else if (value === "yes-exact") {
      persistAllowRule(`Skill(${escapeRuleContent(skillName)})`);
      onApprove();
    } else if (value === "no") {
      onDeny(feedback.getFeedbackFor("no"));
    }
  };

  return (
    <>
      <PermissionDialog title="Use Skill" explanation={explanation}>
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text dimColor>
            DeepSeek Code may use instructions, code, or files from this Skill.
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text>Do you want to use the Skill {skillName}?</Text>
          <PermissionSelect
            options={feedback.selectOptions}
            initialFocus={feedback.selectOptions[0]?.value}
            onSelect={handleSelect}
            onCancel={() => onDeny()}
            onFocusChange={feedback.handleFocusChange}
            onInputModeToggle={feedback.handleInputModeToggle}
          />
        </Box>
      </PermissionDialog>
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>
          Esc to cancel
          {feedback.showTabHint && " · Tab to amend"}
        </Text>
      </Box>
    </>
  );
}

function PlanModePermissionRequest({
  entering,
  onApprove,
  onDeny,
}: {
  entering: boolean;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  const options: PermissionOption[] = [
    { label: entering ? "Yes, enter plan mode" : "Yes, exit plan mode", value: "yes" },
    {
      label: entering ? "No, start implementing now" : "No, stay in plan mode",
      value: "no",
    },
  ];
  const feedback = usePermissionFeedback(options, options[0]?.value);

  const handleSelect = (value: string) => {
    if (value === "yes") {
      onApprove();
    } else {
      onDeny();
    }
  };

  return (
    <>
      <PermissionDialog title={entering ? "Enter plan mode?" : "Exit plan mode?"}>
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text>
            {entering
              ? "The agent wants to enter plan mode to explore and design an implementation approach."
              : "The agent wants to leave plan mode and start making changes."}
          </Text>
          {entering && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>In plan mode, the agent will:</Text>
              <Text dimColor> · Explore the codebase thoroughly</Text>
              <Text dimColor> · Identify existing patterns</Text>
              <Text dimColor> · Design an implementation strategy</Text>
              <Text dimColor> · Present a plan for your approval</Text>
            </Box>
          )}
        </Box>
        <Box flexDirection="column">
          <PermissionSelect
            options={feedback.selectOptions}
            initialFocus={feedback.selectOptions[0]?.value}
            onSelect={handleSelect}
            onCancel={() => onDeny()}
            onFocusChange={feedback.handleFocusChange}
            onInputModeToggle={feedback.handleInputModeToggle}
          />
        </Box>
      </PermissionDialog>
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </>
  );
}

function AskUserQuestionPermissionRequest({
  description,
  onApprove,
  onDeny,
}: {
  description: string;
  onApprove: (value?: string, feedback?: string) => void;
  onDeny: (feedback?: string) => void;
}) {
  const options: PermissionOption[] = [
    { label: "Answer", value: "yes", feedbackType: "accept", placeholder: "your answer" },
    { label: "Skip", value: "no", feedbackType: "reject", placeholder: "reason to skip" },
  ];
  const feedback = usePermissionFeedback(options, options[0]?.value);

  const handleSelect = (value: string) => {
    if (value === "yes") {
      // The typed feedback IS the answer — the tool reads decision.feedback.
      onApprove(undefined, feedback.getFeedbackFor("yes"));
    } else {
      onDeny(feedback.getFeedbackFor("no"));
    }
  };

  return (
    <>
      <PermissionDialog title="Answer question">
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text>{description}</Text>
        </Box>
        <Box flexDirection="column">
          <Text>Answer the question or skip?</Text>
          <PermissionSelect
            options={feedback.selectOptions}
            initialFocus={feedback.selectOptions[0]?.value}
            onSelect={handleSelect}
            onCancel={() => onDeny()}
            onFocusChange={feedback.handleFocusChange}
            onInputModeToggle={feedback.handleInputModeToggle}
          />
        </Box>
      </PermissionDialog>
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>
          Esc to cancel
          {feedback.showTabHint && " · Tab to amend"}
        </Text>
      </Box>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Default export — dispatch on toolName                               */
/* ------------------------------------------------------------------ */

export default function PermissionPrompt(props: PermissionPromptProps) {
  const { toolName, description, input, workingDir, onApprove, onDeny } = props;

  // Materialize lazy descriptions exactly once, when the prompt actually
  // renders — Write/Edit preview thunks (file read + diff) never run in
  // auto-approve or headless modes.
  const desc = typeof description === "function" ? description() : description;

  const explanation = useRuleExplanation(toolName, input, workingDir, props.explanation);

  if (toolName === "Edit") {
    return (
      <FileEditPermissionRequest
        file_path={inputString(input, "file_path")}
        edits={[
          {
            old_string: inputString(input, "old_string"),
            new_string: inputString(input, "new_string"),
            replace_all: inputBool(input, "replace_all"),
          },
        ]}
        explanation={explanation}
        workingDir={workingDir}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );
  }

  if (toolName === "Write") {
    return (
      <FileWritePermissionRequest
        file_path={inputString(input, "file_path")}
        content={inputString(input, "content")}
        explanation={explanation}
        workingDir={workingDir}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );
  }

  if (toolName === "Bash" || toolName === "PowerShell") {
    return (
      <ShellPermissionRequest
        toolName={toolName}
        command={inputString(input, "command") || desc}
        description={desc}
        explanation={explanation}
        workingDir={workingDir}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );
  }

  if (toolName === "FileRead") {
    const file_path = inputString(input, "file_path");
    if (file_path) {
      return (
        <ReadFilePermissionRequest
          file_path={file_path}
          explanation={explanation}
          workingDir={workingDir}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      );
    }
  }

  if (toolName === "Glob" || toolName === "Grep") {
    const directory = inputString(input, "path") || inputString(input, "file_path");
    if (directory) {
      return (
        <SearchFilesPermissionRequest
          directory={directory}
          explanation={explanation}
          workingDir={workingDir}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      );
    }
  }

  if (toolName === "NotebookEdit") {
    return (
      <NotebookEditPermissionRequest
        description={desc}
        input={input}
        explanation={explanation}
        workingDir={workingDir}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );
  }

  if (toolName === "WebFetch") {
    return (
      <WebFetchPermissionRequest
        description={desc}
        input={input}
        explanation={explanation}
        workingDir={workingDir}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );
  }

  if (toolName === "Skill") {
    return (
      <SkillPermissionRequest
        description={desc}
        input={input}
        explanation={explanation}
        workingDir={workingDir}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );
  }

  if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode") {
    return (
      <PlanModePermissionRequest
        entering={toolName === "EnterPlanMode"}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );
  }

  if (toolName === "AskUserQuestion" || toolName.startsWith("AskUserQuestion:")) {
    return (
      <AskUserQuestionPermissionRequest
        description={desc}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );
  }

  return (
    <FallbackPermissionRequest
      toolName={toolName}
      description={desc}
      explanation={explanation}
      workingDir={workingDir}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}
