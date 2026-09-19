import type { AskUserQuestion } from "../types/index.js";

/** questionIndex -> selected row indexes (indexes into rowsForQuestion(), NOT into question.options). */
export type QuestionSelections = Record<number, readonly number[]>;
/** questionIndex -> the text typed into the synthesized "Other" row. */
export type QuestionFreeText = Record<number, string>;

export type QuestionStep =
  | { kind: "question"; index: number }
  | { kind: "review" };

export type QuestionRow =
  | { kind: "option"; label: string; description: string }
  | { kind: "other"; label: "Other"; placeholder: string }
  | { kind: "chat"; label: "Chat about this" };

const OTHER_LABEL = "Other";
const CHAT_LABEL = "Chat about this";
/** Stands in for the model-side "Other" option — the engine matches on this exact token. */
const OTHER_SENTINEL = "__other__";

export function rowsForQuestion(question: AskUserQuestion): QuestionRow[] {
  return [
    ...question.options.map((option) => ({
      kind: "option" as const,
      label: option.label,
      description: option.description,
    })),
    {
      kind: "other" as const,
      label: OTHER_LABEL,
      placeholder: question.multiSelect ? "Type something" : "Type something.",
    },
    { kind: "chat" as const, label: CHAT_LABEL },
  ];
}

export function otherRowIndex(question: AskUserQuestion): number {
  return question.options.length;
}

export function chatRowIndex(question: AskUserQuestion): number {
  return question.options.length + 1;
}

export function isOtherRow(question: AskUserQuestion, rowIndex: number): boolean {
  return rowIndex === otherRowIndex(question);
}

export function isChatRow(question: AskUserQuestion, rowIndex: number): boolean {
  return rowIndex === chatRowIndex(question);
}

export function nextQuestionStep(questionIndex: number, questionCount: number): QuestionStep {
  return questionIndex + 1 < questionCount
    ? { kind: "question", index: questionIndex + 1 }
    : { kind: "review" };
}

export function toggleQuestionSelection(
  selected: readonly number[],
  rowIndex: number,
  multiSelect = false,
): number[] {
  if (!multiSelect) return [rowIndex];
  return selected.includes(rowIndex)
    ? selected.filter((index) => index !== rowIndex)
    : [...selected, rowIndex];
}

/** Undefined means the question goes unanswered — callers omit it rather than guess. */
function answerForQuestion(
  question: AskUserQuestion,
  selectedRows: readonly number[],
  text: string,
): string | undefined {
  const rows = selectedRows.filter((rowIndex) => rowIndex !== chatRowIndex(question));
  const otherSelected = rows.includes(otherRowIndex(question));
  const optionLabels = question.options
    .filter((_, optionIndex) => rows.includes(optionIndex))
    .map((option) => option.label);

  if (!question.multiSelect) {
    if (otherSelected) return text.trim().length > 0 ? text : OTHER_SENTINEL;
    const [firstOption] = optionLabels;
    return firstOption !== undefined ? firstOption : undefined;
  }

  const parts = otherSelected && text.trim().length > 0 ? [...optionLabels, text] : optionLabels;
  return parts.length > 0 ? parts.join(", ") : undefined;
}

export function answersForQuestionSelections(
  questions: readonly AskUserQuestion[],
  selections: QuestionSelections,
  freeText: QuestionFreeText,
): Record<string, string> {
  const answers: Record<string, string> = {};

  for (const [questionIndex, question] of questions.entries()) {
    const answer = answerForQuestion(
      question,
      selections[questionIndex] ?? [],
      freeText[questionIndex] ?? "",
    );
    if (answer !== undefined) answers[question.question] = answer;
  }

  return answers;
}

export function unansweredQuestions(
  questions: readonly AskUserQuestion[],
  selections: QuestionSelections,
  freeText: QuestionFreeText,
): string[] {
  return questions
    .filter(
      (question, questionIndex) =>
        answerForQuestion(
          question,
          selections[questionIndex] ?? [],
          freeText[questionIndex] ?? "",
        ) === undefined,
    )
    .map((question) => question.question);
}

export function clarifyFeedback(
  questions: readonly AskUserQuestion[],
  selections: QuestionSelections,
  freeText: QuestionFreeText,
): string {
  const lines = questions.map((question, questionIndex) => {
    const answer = answerForQuestion(
      question,
      selections[questionIndex] ?? [],
      freeText[questionIndex] ?? "",
    );
    return answer === undefined
      ? `- "${question.question}"\n  (No answer provided)`
      : `- "${question.question}"\n  Answer: ${answer}`;
  });

  return `The user wants to clarify these questions.
    This means they may have additional information, context or questions for you.
    Take their response into account and then reformulate the questions if appropriate.
    Start by asking them what they would like to clarify.

    Questions asked:
${lines.join("\n")}`;
}
