import assert from "node:assert/strict";
import test from "node:test";

import {
  allQuestionsAnswered,
  buildUserQuestionResult,
  createUserQuestionState,
  hasQuestionPreview,
  userQuestionReducer,
  visibleQuestionOptions,
} from "./user-question-state.js";

const questions = [
  {
    id: "approach",
    header: "Approach",
    question: "Which approach?",
    options: [
      { label: "Small", description: "Small change", preview: "**Small** preview" },
      { label: "Large", description: "Large change", preview: "`Large` preview" },
    ],
  },
  {
    id: "features",
    header: "Features",
    question: "Which features?",
    multiSelect: true,
    options: [
      { label: "A", description: "Feature A" },
      { label: "B", description: "Feature B" },
    ],
  },
];

test("preview questions omit Other while ordinary questions include it", () => {
  assert.equal(hasQuestionPreview(questions[0]), true);
  assert.deepEqual(visibleQuestionOptions(questions[0]).map((option) => option.label), ["Small", "Large"]);
  assert.deepEqual(visibleQuestionOptions(questions[1]).map((option) => option.label), ["A", "B", "Other"]);
});

test("state preserves answers while moving between question and review tabs", () => {
  let state = createUserQuestionState(questions);
  state = userQuestionReducer(state, { type: "select-single", value: "Small" }, questions);
  state = userQuestionReducer(state, { type: "switch-tab", index: 1 }, questions);
  state = userQuestionReducer(state, { type: "toggle-multi", value: "A" }, questions);
  state = userQuestionReducer(state, { type: "toggle-multi", value: "__other__" }, questions);
  state = userQuestionReducer(state, { type: "set-text", field: "custom", value: "Custom" }, questions);
  state = userQuestionReducer(state, { type: "set-text", field: "notes", value: "  keep it simple  " }, questions);
  state = userQuestionReducer(state, { type: "switch-tab", index: 2 }, questions);

  assert.equal(state.view, "review");
  assert.deepEqual(buildUserQuestionResult(questions, state), {
    answers: { approach: "Small", features: "A, Custom" },
    annotations: {
      approach: { preview: "**Small** preview" },
      features: { notes: "keep it simple" },
    },
  });
  assert.equal(allQuestionsAnswered(questions, state), true);
});

test("partial submissions omit unanswered questions", () => {
  let state = createUserQuestionState(questions);
  state = userQuestionReducer(state, { type: "select-single", value: "Large" }, questions);
  assert.deepEqual(buildUserQuestionResult(questions, state), {
    answers: { approach: "Large" },
    annotations: { approach: { preview: "`Large` preview" } },
  });
  assert.equal(allQuestionsAnswered(questions, state), false);
});
