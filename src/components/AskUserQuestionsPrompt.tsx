import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AskUserQuestion } from "../types/index.js";
import { getTheme } from "../utils/theme.js";
import { useTheme } from "../ui/design-system/ThemeProvider.js";
import {
  answersForQuestionSelections,
  canSubmitQuestions,
  nextQuestionStep,
  toggleQuestionSelection,
  type QuestionSelections,
} from "./askUserQuestionsState.js";

interface AskUserQuestionsPromptProps {
  questions: AskUserQuestion[];
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: () => void;
}

function initialFocus(selections: QuestionSelections, questionIndex: number): number {
  return selections[questionIndex]?.[0] ?? 0;
}

export default function AskUserQuestionsPrompt({
  questions,
  onSubmit,
  onCancel,
}: AskUserQuestionsPromptProps) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [focusedOptionIndex, setFocusedOptionIndex] = useState(0);
  const [selections, setSelections] = useState<QuestionSelections>({});
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [isReviewing, setIsReviewing] = useState(false);

  const question = questions[questionIndex];
  if (!question) return null;

  const selected = selections[questionIndex] ?? [];
  const moveToQuestion = useCallback((nextIndex: number, nextSelections: QuestionSelections = selections) => {
    const boundedIndex = Math.max(0, Math.min(questions.length - 1, nextIndex));
    setQuestionIndex(boundedIndex);
    setFocusedOptionIndex(initialFocus(nextSelections, boundedIndex));
    setValidationMessage(null);
    setIsReviewing(false);
  }, [questions.length, selections]);

  const submitAnswers = useCallback((nextSelections: QuestionSelections) => {
    if (!canSubmitQuestions(questions, nextSelections)) {
      setValidationMessage("Choose at least one option for each question before submitting.");
      return;
    }
    onSubmit(answersForQuestionSelections(questions, nextSelections));
  }, [onSubmit, questions]);

  const showReview = useCallback((nextSelections: QuestionSelections) => {
    if (!canSubmitQuestions(questions, nextSelections)) {
      setValidationMessage("Choose at least one option for each question before reviewing your answers.");
      return;
    }
    setValidationMessage(null);
    setIsReviewing(true);
  }, [questions]);

  const advanceFromQuestion = useCallback((nextSelections: QuestionSelections) => {
    const nextStep = nextQuestionStep(questionIndex, questions.length);
    if (nextStep.kind === "review") {
      showReview(nextSelections);
    } else {
      moveToQuestion(nextStep.index, nextSelections);
    }
  }, [moveToQuestion, questionIndex, questions.length, showReview]);

  const chooseFocusedOption = useCallback(() => {
    const nextSelected = toggleQuestionSelection(selected, focusedOptionIndex, question.multiSelect);
    const nextSelections = { ...selections, [questionIndex]: nextSelected };
    setSelections(nextSelections);
    setValidationMessage(null);

    if (question.multiSelect) return;
    advanceFromQuestion(nextSelections);
  }, [advanceFromQuestion, focusedOptionIndex, question.multiSelect, questionIndex, selected, selections]);

  const continueFromMultiSelect = useCallback(() => {
    if (selected.length === 0) {
      setValidationMessage("Select one or more options before continuing.");
      return;
    }
    advanceFromQuestion(selections);
  }, [advanceFromQuestion, questionIndex, selected.length, selections]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (isReviewing) {
      if (key.leftArrow || key.rightArrow || key.tab || (key.shift && key.tab)) {
        moveToQuestion(questions.length - 1);
        return;
      }
      if (key.return) {
        submitAnswers(selections);
      }
      return;
    }
    if (key.upArrow) {
      setFocusedOptionIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setFocusedOptionIndex((index) => Math.min(question.options.length - 1, index + 1));
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
      chooseFocusedOption();
      return;
    }
    if (key.return) {
      if (question.multiSelect) {
        continueFromMultiSelect();
      } else {
        chooseFocusedOption();
      }
    }
  });

  const answers = answersForQuestionSelections(questions, selections);

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
          <Box flexDirection="column" marginTop={1}>
            {questions.map((item) => (
              <Box key={item.header} flexDirection="column" marginBottom={1}>
                <Text>{item.question}</Text>
                <Box paddingLeft={2}>
                  <Text color={theme.success}>{answers[item.header]}</Text>
                </Box>
              </Box>
            ))}
          </Box>
          <Text color={theme.inactive}>Enter submits · ←/→ returns to the last question · Esc to cancel</Text>
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
            {question.options.map((option, optionIndex) => {
              const focused = optionIndex === focusedOptionIndex;
              const chosen = selected.includes(optionIndex);
              const marker = question.multiSelect ? (chosen ? "[x]" : "[ ]") : (chosen ? "(o)" : "( )");

              return (
                <Box key={`${questionIndex}-${option.label}`} flexDirection="column">
                  <Text color={focused ? theme.claude : undefined} bold={focused}>
                    {focused ? "> " : "  "}{marker} {option.label}
                  </Text>
                  <Box paddingLeft={6}>
                    <Text dimColor wrap="wrap">{option.description}</Text>
                  </Box>
                </Box>
              );
            })}
          </Box>

          {validationMessage && (
            <Box marginTop={1}>
              <Text color={theme.warning}>{validationMessage}</Text>
            </Box>
          )}

          <Box marginTop={1}>
            <Text color={theme.inactive}>
              {question.multiSelect ? "Space toggles · Enter continues" : "Enter selects"}
              {questions.length > 1 ? " · ←/→ review" : ""} · Esc to cancel
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
