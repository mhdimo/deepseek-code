import { expect, test } from "bun:test";

import type { AskUserQuestion } from "../../src/types/index.js";
import {
  answersForQuestionSelections,
  canSubmitQuestions,
  nextQuestionStep,
  toggleQuestionSelection,
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

test("replaces a single-select answer when the focused option changes", () => {
  expect(toggleQuestionSelection([0], 2, false)).toEqual([2]);
});

test("toggles multi-select answers without disturbing other selections", () => {
  expect(toggleQuestionSelection([0], 2, true)).toEqual([0, 2]);
  expect(toggleQuestionSelection([0, 2], 0, true)).toEqual([2]);
});

test("returns selected labels under the question headers", () => {
  const answers = answersForQuestionSelections(questions, {
    0: [1],
    1: [2, 0],
  });

  expect(answers).toEqual({
    "Page purpose": "Getting-started guide",
    Include: "Examples, Troubleshooting",
  });
});

test("requires an answer for every question before submitting", () => {
  expect(canSubmitQuestions(questions, { 0: [1], 1: [] })).toBe(false);
  expect(canSubmitQuestions(questions, { 0: [1], 1: [0] })).toBe(true);
});

test("opens an answer review after the final question", () => {
  expect(nextQuestionStep(0, 2)).toEqual({ kind: "question", index: 1 });
  expect(nextQuestionStep(1, 2)).toEqual({ kind: "review" });
});
