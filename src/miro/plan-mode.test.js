import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  approvedPlanPrompt,
  createPlanFile,
  normalizePlanModeState,
  planFilePath,
  planModePrompt,
} from "./plan-mode.js";

test("计划文件位于项目会话的专用目录，并以空文件独占创建", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "miro-plan-"));
  try {
    const options = { cwd: "/work/my project", sessionId: "session/1", planId: "plan:1", home };
    const expected = path.join(home, ".miro/sessions/-work-my-project/miro/plans/session_1/plan_1.md");
    assert.equal(planFilePath(options), expected);
    assert.equal(await createPlanFile(options), expected);
    assert.equal(readFileSync(expected, "utf8"), "");
    await assert.rejects(createPlanFile(options), /exist/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("计划状态只接受完整、合法的快照", () => {
  assert.deepEqual(normalizePlanModeState({ mode: "default" }), {
    mode: "default",
    planId: null,
    planPath: null,
  });
  assert.deepEqual(normalizePlanModeState({ mode: "plan", planId: "p1", planPath: "/tmp/p1.md" }), {
    mode: "plan",
    planId: "p1",
    planPath: "/tmp/p1.md",
  });
  assert.equal(normalizePlanModeState({ mode: "plan", planId: "p1" }), null);
  assert.equal(normalizePlanModeState({ mode: "other" }), null);
});

test("交互与非交互计划提示采用不同的结束协议", () => {
  assert.match(planModePrompt("/tmp/plan.md", true), /call exit_plan_mode/);
  assert.match(planModePrompt("/tmp/plan.md", false), /visible final response/);
  assert.doesNotMatch(planModePrompt("/tmp/plan.md", false), /call exit_plan_mode/);
  const frozen = approvedPlanPrompt("# Plan\n\nDo it");
  assert.match(frozen, /<approved_plan>/);
  assert.match(frozen, /frozen snapshot/);
  assert.match(frozen, /# Plan/);
});
