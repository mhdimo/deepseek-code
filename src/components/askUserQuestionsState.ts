import type { AskUserQuestion } from "../types/index.js";

export type QuestionSelections = Record<number, readonly number[]>;

export type QuestionStep =
  | { kind: "question"; index: number }
  | { kind: "review" };

export function nextQuestionStep(questionIndex: number, questionCount: number): QuestionStep {
  return questionIndex + 1 < questionCount
    ? { kind: "question", index: questionIndex + 1 }
    : { kind: "review" };
}

export function toggleQuestionSelection(
  selected: readonly number[],
  optionIndex: number,
  multiSelect = false,
): number[] {
  if (!multiSelect) return [optionIndex];
  return selected.includes(optionIndex)
    ? selected.filter((index) => index !== optionIndex)
    : [...selected, optionIndex];
}

export function answersForQuestionSelections(
  questions: readonly AskUserQuestion[],
  selections: QuestionSelections,
): Record<string, string> {
  const answers: Record<string, string> = {};

  for (const [questionIndex, question] of questions.entries()) {
    const selected = new Set(selections[questionIndex] ?? []);
    const labels = question.options
      .filter((_, optionIndex) => selected.has(optionIndex))
      .map((option) => option.label);

    if (labels.length > 0) answers[question.header] = labels.join(", ");
  }

  return answers;
}

export function canSubmitQuestions(
  questions: readonly AskUserQuestion[],
  selections: QuestionSelections,
): boolean {
  return questions.every((_, questionIndex) => (selections[questionIndex]?.length ?? 0) > 0);
}
