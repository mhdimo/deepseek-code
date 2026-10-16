import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AskUserQuestion } from "../types/index.js";
import type { AskUserQuestionsResult } from "../Tool.js";
import { getTheme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";
import { ClickRegionBox } from "./mouseRegions.js";
import { FOCUS_MARKER, OPTION_GUTTER_WIDTH, optionIndexWidth } from "./permissionLayout.js";
import {
  answersForQuestionSelections,
  clarifyFeedback,
  isChatRow,
  isOtherRow,
  nextQuestionStep,
  otherRowIndex,
  rowsForQuestion,
  toggleQuestionSelection,
  unansweredQuestions,
  type QuestionFreeText,
  type QuestionSelections,
} from "./askUserQuestionsState.js";

interface AskUserQuestionsPromptProps {
  questions: AskUserQuestion[];
  onResult: (result: AskUserQuestionsResult) => void;
}

/** Columns taken by a multi-select row's checkbox before its label. */
const MULTI_MARKER_WIDTH = "[✔] ".length;

function initialFocus(selections: QuestionSelections, questionIndex: number): number {
  return selections[questionIndex]?.[0] ?? 0;
}

export default function AskUserQuestionsPrompt({
  questions,
  onResult,
}: AskUserQuestionsPromptProps) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [focusedRowIndex, setFocusedRowIndex] = useState(0);
  const [selections, setSelections] = useState<QuestionSelections>({});
  const [freeText, setFreeText] = useState<QuestionFreeText>({});
  const [isReviewing, setIsReviewing] = useState(false);

  const question = questions[questionIndex];
  if (!question) return null;

  const rows = rowsForQuestion(question);
  const selected = selections[questionIndex] ?? [];
  const otherText = freeText[questionIndex] ?? "";
  const typingOther = isOtherRow(question, focusedRowIndex);
  const indexWidth = optionIndexWidth(rows.length);
  // A multi-select row carries a "[✔] " prefix between its number and its
  // label; the description follows the label, not the number.
  const descriptionIndent =
    OPTION_GUTTER_WIDTH + indexWidth + 2 + (question.multiSelect ? MULTI_MARKER_WIDTH : 0);

  const moveToQuestion = (nextIndex: number, nextSelections: QuestionSelections = selections) => {
    const boundedIndex = Math.max(0, Math.min(questions.length - 1, nextIndex));
    setQuestionIndex(boundedIndex);
    setFocusedRowIndex(initialFocus(nextSelections, boundedIndex));
    setIsReviewing(false);
  };

  const submitAnswers = (nextSelections: QuestionSelections, nextFreeText: QuestionFreeText) => {
    onResult({
      kind: "answered",
      answers: answersForQuestionSelections(questions, nextSelections, nextFreeText),
    });
  };

  const advanceFromQuestion = (nextSelections: QuestionSelections, nextFreeText: QuestionFreeText) => {
    const nextStep = nextQuestionStep(questionIndex, questions.length);
    if (nextStep.kind === "review") {
      setIsReviewing(true);
    } else {
      moveToQuestion(nextStep.index, nextSelections);
    }
  };

  const continueFromQuestion = () => {
    advanceFromQuestion(selections, freeText);
  };

  const toggleRow = (rowIndex: number) => {
    setSelections({
      ...selections,
      [questionIndex]: toggleQuestionSelection(selected, rowIndex, question.multiSelect),
    });
  };

  const answerRow = (rowIndex: number) => {
    const nextSelections = {
      ...selections,
      [questionIndex]: toggleQuestionSelection(selected, rowIndex, false),
    };
    setSelections(nextSelections);

    // A lone single-select question is answered the moment it is chosen — the
    // reference's hideSubmitTab skips the review step entirely.
    if (questions.length === 1) {
      submitAnswers(nextSelections, freeText);
      return;
    }
    advanceFromQuestion(nextSelections, freeText);
  };

  // A click mirrors the row's own keyboard action: Space for a toggleable
  // option in a multi-select, Enter for a single choice, focus-only for the
  // Other field (a click says "let me type", not "submit blank"/"cancel"),
  // and Enter for the Chat footer.
  const clickRow = (rowIndex: number): void => {
    setFocusedRowIndex(rowIndex);
    const row = rows[rowIndex];
    if (!row) return;
    if (row.kind === "option") {
      if (question.multiSelect) toggleRow(rowIndex);
      else answerRow(rowIndex);
      return;
    }
    if (row.kind === "chat") {
      onResult({ kind: "clarify", feedback: clarifyFeedback(questions, selections, freeText) });
    }
  };

  const setOtherText = (nextText: string) => {
    setFreeText({ ...freeText, [questionIndex]: nextText });

    if (!question.multiSelect) return;
    // In a multi-select the typed answer *is* the selection: it joins the
    // selection as soon as there is something to submit, and drops out again
    // when the field is cleared.
    const otherIndex = otherRowIndex(question);
    if (nextText.trim().length > 0 === selected.includes(otherIndex)) return;
    toggleRow(otherIndex);
  };

  useInput((input, key) => {
    if (key.escape) {
      onResult({ kind: "cancelled" });
      return;
    }
    if (isReviewing) {
      if (key.leftArrow || key.rightArrow || key.tab) {
        moveToQuestion(questions.length - 1);
        return;
      }
      if (key.return) {
        submitAnswers(selections, freeText);
      }
      return;
    }
    if (key.upArrow) {
      setFocusedRowIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setFocusedRowIndex((index) => Math.min(rows.length - 1, index + 1));
      return;
    }
    if (key.return) {
      if (isChatRow(question, focusedRowIndex)) {
        onResult({ kind: "clarify", feedback: clarifyFeedback(questions, selections, freeText) });
        return;
      }
      if (question.multiSelect) {
        continueFromQuestion();
        return;
      }
      // An empty Other row hands the question back unanswered; the reference
      // cancels rather than selecting a blank answer.
      if (typingOther && otherText.trim().length === 0) {
        onResult({ kind: "cancelled" });
        return;
      }
      answerRow(focusedRowIndex);
      return;
    }
    // The Other row owns the keyboard while it is focused: Tab and the arrow
    // keys belong to the text field, so they must not switch questions.
    if (typingOther) {
      if (key.tab || key.leftArrow || key.rightArrow) return;
      if (key.backspace || key.delete) {
        setOtherText(otherText.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setOtherText(otherText + input);
      }
      return;
    }
    if (key.leftArrow || (key.shift && key.tab)) {
      moveToQuestion(questionIndex - 1);
      return;
    }
    if (key.rightArrow || key.tab) {
      moveToQuestion(questionIndex + 1);
      return;
    }
    if (question.multiSelect && input === " ") {
      toggleRow(focusedRowIndex);
    }
  });

  const answers = answersForQuestionSelections(questions, selections, freeText);
  const missing = unansweredQuestions(questions, selections, freeText);
  const hint = question.multiSelect
    ? `Space toggles · Enter continues${questions.length > 1 ? " · Tab/Arrow keys to navigate" : ""} · Esc to cancel`
    : questions.length === 1
      ? "Enter to select · ↑/↓ to navigate · Esc to cancel"
      : "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.permission}
      paddingX={1}
      width="100%"
      flexShrink={0}
    >
      {isReviewing ? (
        <>
          <Text color={theme.permission} bold>Review your answers</Text>
          {missing.length > 0 && (
            <Box marginTop={1}>
              <Text color={theme.warning}>⚠ You have not answered all questions</Text>
            </Box>
          )}
          <Box flexDirection="column" marginTop={1}>
            {questions.map((item) => {
              const answer = answers[item.question];
              if (!answer) return null;
              return (
                <Box key={item.question} flexDirection="column" marginBottom={1} paddingLeft={1}>
                  <Text>● {item.question}</Text>
                  <Box paddingLeft={2}>
                    <Text color={theme.success}>→ {answer}</Text>
                  </Box>
                </Box>
              );
            })}
          </Box>
          <Text color={theme.inactive}>Ready to submit your answers?</Text>
          <Box marginTop={1}>
            <Text color={theme.inactive}>
              Enter submits · ←/→ returns to the questions · Esc to cancel
            </Text>
          </Box>
        </>
      ) : (
        <>
          <Text color={theme.permission} bold>
            Question {questionIndex + 1} of {questions.length}
            <Text dimColor> · {question.header}</Text>
          </Text>

          <Box marginTop={1}>
            <Text wrap="wrap">{question.question}</Text>
          </Box>

          <Box flexDirection="column" marginTop={1}>
            {rows.map((row, rowIndex) => {
              const focused = rowIndex === focusedRowIndex;
              const chosen = selected.includes(rowIndex);
              const label =
                row.kind === "option"
                  ? row.label
                  : row.kind === "other"
                    ? otherText || row.placeholder
                    : row.label;

              let labelColor: string | undefined;
              if (row.kind === "other" && !otherText) {
                labelColor = theme.inactive;
              } else if (!question.multiSelect && chosen && row.kind !== "chat") {
                labelColor = theme.success;
              }

              return (
                <ClickRegionBox
                  key={`${questionIndex}-${rowIndex}`}
                  flexDirection="column"
                  onClickRegion={() => clickRow(rowIndex)}
                  // Hover moves the focus, never toggles or answers — a click
                  // still runs the row's own key action.
                  onHoverRegion={() => setFocusedRowIndex(rowIndex)}
                >
                  <Text>
                    <Text color={focused ? theme.claude : undefined}>
                      {focused ? `${FOCUS_MARKER} ` : " ".repeat(OPTION_GUTTER_WIDTH)}
                    </Text>
                    <Text dimColor>{`${rowIndex + 1}.`.padEnd(indexWidth + 2)}</Text>
                    {/* The reference brackets the Other input row like any
                        other selectable row; "Chat about this" is a footer. */}
                    {question.multiSelect && row.kind !== "chat" && (
                      <Text>
                        [<Text color={theme.success}>{chosen ? "✔" : " "}</Text>{"] "}
                      </Text>
                    )}
                    <Text color={labelColor}>{label}</Text>
                    {focused && row.kind === "other" && (
                      <Text color={theme.claude}>▌</Text>
                    )}
                    {!question.multiSelect && chosen && <Text color={theme.success}> ✔</Text>}
                  </Text>
                  {row.kind === "option" && (
                    <Box paddingLeft={descriptionIndent}>
                      <Text dimColor wrap="wrap">{row.description}</Text>
                    </Box>
                  )}
                </ClickRegionBox>
              );
            })}
          </Box>

          <Box marginTop={1}>
            <Text color={theme.inactive}>{hint}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
