import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  enterPlanModeTool,
  exitPlanModeTool,
  requestUserInputTool,
} from "./plan-mode.js";
import { createToolRunners } from "./index.js";

test("enter_plan_mode only transitions after confirmation", async () => {
  assert.equal((await enterPlanModeTool(async () => false)({})).stopTurn, undefined);
  assert.deepEqual((await enterPlanModeTool(async () => true)({})).transition, { type: "plan_entered" });
});

test("request_user_input validates its extended shape and returns answers with annotations", async () => {
  const run = requestUserInputTool(async (questions) => ({
    answers: { [questions[0].id]: "A", ignored: "no" },
    annotations: { [questions[0].id]: { preview: " **A** ", notes: " note " } },
  }));
  assert.match((await run({ questions: [] })).error, /1-4 valid questions/);
  const result = await run({
    questions: [{
      id: "choice",
      header: "Choice",
      question: "Which one?",
      options: [
        { label: "A", description: "First", preview: "**A**" },
        { label: "B", description: "Second" },
      ],
    }],
  });
  assert.deepEqual(JSON.parse(result.output), {
    answers: { choice: "A" },
    annotations: { choice: { preview: "**A**", notes: "note" } },
  });
});

test("request_user_input rejects duplicate labels and previews on multi-select questions", async () => {
  const run = requestUserInputTool(async () => ({ answers: {} }));
  const base = {
    id: "features",
    header: "Features",
    question: "Which features?",
    multiSelect: true,
  };
  assert.match((await run({ questions: [{
    ...base,
    options: [
      { label: "A", description: "First" },
      { label: "A", description: "Again" },
    ],
  }] })).error, /unique options/);
  assert.match((await run({ questions: [{
    ...base,
    options: [
      { label: "A", description: "First", preview: "preview" },
      { label: "B", description: "Second" },
    ],
  }] })).error, /single-select only/);
});

test("exit_plan_mode freezes canonical content and supports approval, revision, rejection and dismissal", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "miro-plan-tool-"));
  const file = path.join(dir, "plan.md");
  try {
    writeFileSync(file, "# Frozen plan\n");
    const approve = await exitPlanModeTool({
      plan: { path: file },
      requestReview: async ({ plan }) => {
        assert.equal(plan, "# Frozen plan\n");
        writeFileSync(file, "# Mutated later\n");
        return { action: "approve" };
      },
    })({});
    assert.equal(approve.stopTurn, true);
    assert.equal(approve.transition.plan, "# Frozen plan\n");

    writeFileSync(file, "# Plan\n");
    const revise = await exitPlanModeTool({
      plan: { path: file },
      requestReview: async () => ({ action: "revise", feedback: "Add rollback" }),
    })({});
    assert.match(revise.output, /Add rollback/);
    assert.equal(revise.stopTurn, undefined);

    const reject = await exitPlanModeTool({
      plan: { path: file },
      requestReview: async () => ({ action: "reject" }),
    })({});
    assert.deepEqual(reject.transition, { type: "plan_rejected" });

    const dismiss = await exitPlanModeTool({ plan: { path: file }, requestReview: async () => null })({});
    assert.deepEqual(dismiss.transition, { type: "plan_review_dismissed" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Plan runners keep normal write and terminal capabilities", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "miro-plan-guard-"));
  const planPath = path.join(dir, "plan.md");
  let executions = 0;
  try {
    writeFileSync(planPath, "");
    const runners = createToolRunners({
      cwd: dir,
      tools: ["write_file", "terminal"],
      plan: { path: planPath },
      startBash: () => {
        executions += 1;
        return { result: Promise.resolve({ stdout: "", stderr: "", outcome: { type: "exited", code: 0 } }) };
      },
    });
    assert.equal((await runners.write_file({ path: "other.md", content: "allowed" })).error, undefined);
    assert.equal((await runners.write_file({ path: planPath, content: "# Plan\n" })).error, undefined);
    assert.equal((await runners.terminal({ command: "touch changed.txt" })).error, undefined);
    assert.equal(executions, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
