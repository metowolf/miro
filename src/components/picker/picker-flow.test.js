import assert from "node:assert/strict";
import test from "node:test";

import {
  createFlowState,
  currentStep,
  goBack,
  hasPreviousStep,
  selectValue,
  stepView,
} from "./picker-flow.js";

const MODEL_STEP = {
  key: "model",
  title: "Select model",
  items: () => [{ value: "opus", label: "Opus" }, { value: "sonnet", label: "Sonnet" }],
};

const EFFORT_STEP = {
  key: "effort",
  title: (ctx) => `Effort for ${ctx.model}`,
  items: () => [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
};

test("the first step starts at the first step that is not skipped", () => {
  const state = createFlowState([MODEL_STEP, EFFORT_STEP]);
  assert.equal(currentStep(state).key, "model");
  assert.equal(state.done, false);
});

test("selectValue writes into context and advances to the next step", () => {
  let state = createFlowState([MODEL_STEP, EFFORT_STEP]);
  state = selectValue(state, "opus");
  assert.equal(state.context.model, "opus");
  assert.equal(currentStep(state).key, "effort");
  assert.equal(state.done, false);
});

test("done is true and context is complete after the last step", () => {
  let state = createFlowState([MODEL_STEP, EFFORT_STEP]);
  state = selectValue(state, "opus");
  state = selectValue(state, "high");
  assert.equal(state.done, true);
  assert.deepEqual(state.context, { model: "opus", effort: "high" });
  assert.equal(currentStep(state), null);
});

test("fields like title may be functions of context", () => {
  let state = createFlowState([MODEL_STEP, EFFORT_STEP]);
  state = selectValue(state, "sonnet");
  assert.equal(stepView(state).title, "Effort for sonnet");
});

test("steps whose skip is true are skipped automatically", () => {
  const state = createFlowState([
    { ...MODEL_STEP, skip: () => true },
    EFFORT_STEP,
  ]);
  assert.equal(currentStep(state).key, "effort");
});

test("skip can depend on the accumulated context", () => {
  let state = createFlowState([
    MODEL_STEP,
    { ...EFFORT_STEP, skip: (ctx) => ctx.model === "sonnet" },
  ]);
  state = selectValue(state, "sonnet");
  assert.equal(state.done, true, "sonnet has no effort step, so the flow completes directly");
  assert.deepEqual(state.context, { model: "sonnet" });
});

test("finishes immediately when every step is skipped", () => {
  const state = createFlowState([
    { ...MODEL_STEP, skip: () => true },
    { ...EFFORT_STEP, skip: () => true },
  ]);
  assert.equal(state.done, true);
  assert.equal(currentStep(state), null);
});

test("the first step has no target to go back to", () => {
  const state = createFlowState([MODEL_STEP, EFFORT_STEP]);
  assert.equal(hasPreviousStep(state), false);
  assert.equal(goBack(state), null, "going back on the first step returns null and cancels the flow");
});

test("goBack steps back one step and deletes that step's context key", () => {
  const mid = selectValue(createFlowState([MODEL_STEP, EFFORT_STEP]), "opus");
  const back = goBack(mid);
  assert.equal(currentStep(back).key, "model");
  assert.equal("model" in back.context, false, "going back clears that step's value so a new pick is not polluted");
});

test("goBack skips over skipped middle steps", () => {
  const steps = [
    MODEL_STEP,
    { key: "middle", title: "Middle", items: () => [], skip: () => true },
    EFFORT_STEP,
  ];
  let state = createFlowState(steps);
  state = selectValue(state, "opus");
  assert.equal(currentStep(state).key, "effort");
  const back = goBack(state);
  assert.equal(currentStep(back).key, "model");
});

test("canGoBack is false on the first step and true afterwards", () => {
  let state = createFlowState([MODEL_STEP, EFFORT_STEP]);
  assert.equal(stepView(state).canGoBack, false);
  state = selectValue(state, "opus");
  assert.equal(stepView(state).canGoBack, true);
});

test("preselect and items are resolved from context", () => {
  const state = createFlowState([
    {
      key: "model",
      title: "T",
      items: (ctx) => [{ value: ctx.seed }],
      preselect: () => 0,
    },
  ], { seed: "from-context" });
  const view = stepView(state);
  assert.deepEqual(view.items, [{ value: "from-context" }]);
  assert.equal(view.selected, 0);
});

test("initialContext is carried into the final result", () => {
  let state = createFlowState([MODEL_STEP], { origin: "cli" });
  state = selectValue(state, "opus");
  assert.deepEqual(state.context, { origin: "cli", model: "opus" });
});

test("searchable defaults to true", () => {
  const state = createFlowState([MODEL_STEP]);
  assert.equal(stepView(state).searchable, true);
});
