import { expect, test } from "bun:test";

import type { AskUserQuestion } from "../../src/types/index.js";
import {
  answersForQuestionSelections,
  chatRowIndex,
  clarifyFeedback,
  isChatRow,
  isOtherRow,
  nextQuestionStep,
  otherRowIndex,
  rowsForQuestion,
  toggleQuestionSelection,
  unansweredQuestions,
} from "../../src/components/askUserQuestionsState.js";

const questions: AskUserQuestion[] = [
  {
    header: "Page purpose",
    question: "What should the page be?",
    options: [
      { label: "Command cheatsheet", description: "Reference commands" },
      { label: "Getting-started guide", description: "Help new users" },
      { label: "Agent tour", description: "Show an agent turn" },
    ],
  },
  {
    header: "Include",
    question: "Which sections should be included?",
    multiSelect: true,
    options: [
      { label: "Examples", description: "Concrete examples" },
      { label: "Keyboard shortcuts", description: "Useful controls" },
      { label: "Troubleshooting", description: "Common failures" },
    ],
  },
];

test("lists options first, then the synthesized Other and Chat rows", () => {
  expect(rowsForQuestion(questions[0]!)).toEqual([
    { kind: "option", label: "Command cheatsheet", description: "Reference commands" },
    { kind: "option", label: "Getting-started guide", description: "Help new users" },
    { kind: "option", label: "Agent tour", description: "Show an agent turn" },
    { kind: "other", label: "Other", placeholder: "Type something." },
    { kind: "chat", label: "Chat about this" },
  ]);
});

test("uses the multi-select placeholder without a trailing period", () => {
  const rows = rowsForQuestion(questions[1]!);
  expect(rows[rows.length - 2]).toEqual({
    kind: "other",
    label: "Other",
    placeholder: "Type something",
  });
  expect(rows[rows.length - 1]).toEqual({ kind: "chat", label: "Chat about this" });
});

test("places the synthetic rows after the last option", () => {
  expect(otherRowIndex(questions[0]!)).toBe(3);
  expect(chatRowIndex(questions[0]!)).toBe(4);
  expect(isOtherRow(questions[0]!, 3)).toBe(true);
  expect(isOtherRow(questions[0]!, 2)).toBe(false);
  expect(isChatRow(questions[0]!, 4)).toBe(true);
  expect(isChatRow(questions[0]!, 3)).toBe(false);
});

test("replaces a single-select answer when the focused row changes", () => {
  expect(toggleQuestionSelection([0], 2, false)).toEqual([2]);
  expect(toggleQuestionSelection([0], 3, false)).toEqual([3]);
});

test("toggles multi-select answers without disturbing other selections", () => {
  expect(toggleQuestionSelection([0], 2, true)).toEqual([0, 2]);
  expect(toggleQuestionSelection([0, 2], 0, true)).toEqual([2]);
});

test("opens an answer review after the final question", () => {
  expect(nextQuestionStep(0, 2)).toEqual({ kind: "question", index: 1 });
  expect(nextQuestionStep(1, 2)).toEqual({ kind: "review" });
});

test("keys answers by question text, not by header", () => {
  const answers = answersForQuestionSelections(questions, { 0: [1] }, {});

  expect(answers).toEqual({ "What should the page be?": "Getting-started guide" });
  expect(answers["Page purpose"]).toBeUndefined();
});

test("answers a single-select question with the chosen option label", () => {
  const answers = answersForQuestionSelections(questions, { 0: [1] }, {});

  expect(answers["What should the page be?"]).toBe("Getting-started guide");
});

test("answers a single-select Other row with the typed text", () => {
  const answers = answersForQuestionSelections(questions, { 0: [3] }, { 0: "A CLI reference" });

  expect(answers["What should the page be?"]).toBe("A CLI reference");
});

test("lets the Other row win over a co-selected option in single-select", () => {
  const answers = answersForQuestionSelections(questions, { 0: [0, 3] }, { 0: "A CLI reference" });

  expect(answers["What should the page be?"]).toBe("A CLI reference");
});

test("falls back to the __other__ sentinel when Other is chosen with no text", () => {
  expect(answersForQuestionSelections(questions, { 0: [3] }, {})["What should the page be?"]).toBe(
    "__other__",
  );
  expect(
    answersForQuestionSelections(questions, { 0: [3] }, { 0: "   " })["What should the page be?"],
  ).toBe("__other__");
});

test("joins multi-select labels with a comma and a space in option order", () => {
  const answers = answersForQuestionSelections(questions, { 1: [2, 0] }, {});

  expect(answers["Which sections should be included?"]).toBe("Examples, Troubleshooting");
});

test("appends the Other text to the multi-select labels", () => {
  const answers = answersForQuestionSelections(questions, { 1: [0, 3] }, { 1: "Migration notes" });

  expect(answers["Which sections should be included?"]).toBe("Examples, Migration notes");
});

test("omits a multi-select question whose only selection is an empty Other", () => {
  expect(answersForQuestionSelections(questions, { 1: [3] }, {})).toEqual({});
  expect(answersForQuestionSelections(questions, { 1: [3] }, { 1: "  " })).toEqual({});
});

test("omits unanswered questions instead of emitting a placeholder", () => {
  const answers = answersForQuestionSelections(questions, { 0: [1], 1: [] }, {});

  expect(answers).toEqual({ "What should the page be?": "Getting-started guide" });
  expect(answers["Which sections should be included?"]).toBeUndefined();
});

test("ignores a selected chat row", () => {
  expect(answersForQuestionSelections(questions, { 0: [4] }, { 0: "unused" })).toEqual({});
});

test("reports the unanswered questions in question order", () => {
  expect(unansweredQuestions(questions, { 0: [1], 1: [] }, {})).toEqual([
    "Which sections should be included?",
  ]);
  expect(
    unansweredQuestions(questions, { 0: [3], 1: [0] }, { 0: "A CLI reference" }),
  ).toEqual([]);
  expect(unansweredQuestions(questions, {}, {})).toEqual([
    "What should the page be?",
    "Which sections should be included?",
  ]);
});

test("builds the clarify feedback verbatim", () => {
  const feedback = clarifyFeedback(questions, { 0: [1], 1: [2, 0] }, {});

  const expected = [
    "The user wants to clarify these questions.",
    "    This means they may have additional information, context or questions for you.",
    "    Take their response into account and then reformulate the questions if appropriate.",
    "    Start by asking them what they would like to clarify.",
    "",
    "    Questions asked:",
    '- "What should the page be?"\n  Answer: Getting-started guide',
    '- "Which sections should be included?"\n  Answer: Examples, Troubleshooting',
  ].join("\n");

  expect(feedback).toBe(expected);
  expect(feedback.endsWith("\n")).toBe(false);
});

test("marks unanswered questions in the clarify feedback", () => {
  const feedback = clarifyFeedback(questions, { 0: [3] }, { 0: "" });

  expect(feedback).toBe(
    [
      "The user wants to clarify these questions.",
      "    This means they may have additional information, context or questions for you.",
      "    Take their response into account and then reformulate the questions if appropriate.",
      "    Start by asking them what they would like to clarify.",
      "",
      "    Questions asked:",
      '- "What should the page be?"\n  Answer: __other__',
      '- "Which sections should be included?"\n  (No answer provided)',
    ].join("\n"),
  );
});
