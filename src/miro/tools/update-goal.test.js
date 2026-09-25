import assert from "node:assert/strict";
import test from "node:test";

import { createGoalState } from "../goal.js";
import {
  createToolRunners,
  isConcurrencySafeCall,
} from "./index.js";
import { setGoalBudgetTool, updateGoalTool } from "./update-goal.js";

function withGoal(objective = "ship it") {
  const goal = createGoalState({ now: () => 1000 });
  goal.create({ objective });
  return goal;
}

test("update_goal completes an active goal and asks the loop to stop", async () => {
  const goal = withGoal();
  const tool = updateGoalTool({ goal });

  const result = await tool({ status: "complete", reason: "tests pass" });

  assert.equal(goal.get().status, "complete");
  assert.equal(goal.get().terminalReason, "tests pass");
  // 终态落定后再起一轮只会产出与结论矛盾的动作。
  assert.equal(result.stopTurn, true);
  assert.match(result.output, /marked complete/);
  assert.match(result.output, /completion summary/);
});

test("update_goal blocks an active goal and prompts for an explanation", async () => {
  const goal = withGoal();
  const result = await updateGoalTool({ goal })({ status: "blocked", reason: "no credentials" });

  assert.equal(goal.get().status, "blocked");
  assert.equal(result.stopTurn, true);
  assert.match(result.output, /Explain the blocker/);
});

test("update_goal resumes a paused goal without stopping the turn", async () => {
  const goal = withGoal();
  goal.pause("interrupted");

  const result = await updateGoalTool({ goal })({ status: "active" });

  assert.equal(goal.get().status, "active");
  // 恢复不是终态，本轮该继续干活。
  assert.equal(result.stopTurn, undefined);
  assert.match(result.output, /resumed/);
});

test("update_goal rejects an unknown status without touching the goal", async () => {
  const goal = withGoal();
  const result = await updateGoalTool({ goal })({ status: "finished" });

  assert.match(result.error, /invalid status/);
  assert.equal(goal.get().status, "active");
});

test("update_goal reports plainly when the goal vanished mid-turn", async () => {
  const goal = withGoal();
  goal.cancel();

  const result = await updateGoalTool({ goal })({ status: "complete" });

  // 用户可能在本轮进行中取消了目标：如实告知，而不是静默新建一个。
  assert.match(result.output, /no current goal/);
  assert.equal(result.stopTurn, undefined);
});

test("update_goal will not complete a goal that is already stopped", async () => {
  const goal = withGoal();
  goal.pause("interrupted");

  const result = await updateGoalTool({ goal })({ status: "complete" });

  assert.match(result.output, /is paused, not active/);
  assert.equal(goal.get().status, "paused");
});

test("set_goal_budget records a converted limit", async () => {
  const goal = withGoal();
  const result = await setGoalBudgetTool({ goal })({ value: 30, unit: "minutes" });

  assert.equal(goal.get().budget.wallClockBudgetMs, 1_800_000);
  assert.match(result.output, /Goal budget set: 30 minutes/);
  assert.equal(result.stopTurn, undefined);
});

test("set_goal_budget stops the turn when the new limit is already exhausted", async () => {
  const goal = withGoal();
  goal.countTurn();
  goal.countTurn();
  goal.countTurn();

  const result = await setGoalBudgetTool({ goal })({ value: 2, unit: "turns" });

  // 「20 轮内完成」但已经跑了 25 轮：立刻停下比跑到下一次预算检查更诚实。
  assert.equal(goal.get().status, "blocked");
  assert.equal(result.stopTurn, true);
  assert.match(result.output, /already reached this budget/);
});

test("set_goal_budget refuses an unreasonable time budget", async () => {
  const goal = withGoal();
  const result = await setGoalBudgetTool({ goal })({ value: 10, unit: "milliseconds" });

  assert.match(result.error, /not a reasonable/);
  assert.equal(goal.get().budget.wallClockBudgetMs, null);
});

// 并发安全意味着同批的多次目标更新一起执行；两者都是纯状态变更，没有副作用顺序。
test("goal tools are concurrency safe so one batch can run them together", () => {
  assert.equal(isConcurrencySafeCall("update_goal", {}), true);
  assert.equal(isConcurrencySafeCall("set_goal_budget", {}), true);
});

test("goal runners are only assembled when a goal state is supplied", () => {
  const withoutGoal = createToolRunners({ cwd: "/work" });
  // 没有 runner 时 schema 也会被过滤掉，模型根本看不到这两个工具。
  assert.equal(withoutGoal.update_goal, undefined);
  assert.equal(withoutGoal.set_goal_budget, undefined);

  const runners = createToolRunners({ cwd: "/work", goal: withGoal() });
  assert.equal(typeof runners.update_goal, "function");
  assert.equal(typeof runners.set_goal_budget, "function");
});

test("sub-agents never inherit the goal tools", async () => {
  // 观察真实传给子循环的白名单，而不是重算一遍过滤逻辑：后者即使实现回退了
  // 也照样通过。子智能体的 tools 会成为它那层 runAgentLoop 的 config.tools。
  let childTools = null;
  const runners = createToolRunners({
    cwd: "/work",
    goal: withGoal(),
    subagent: {
      runLoop: async (args) => {
        childTools = args.config.tools;
        return { stopReason: "end_turn", cancelled: false };
      },
      config: { cwd: "/work", model: "m" },
      dependencies: {},
    },
  });

  await runners.spawn_agent({ description: "check", message: "do it" });

  assert.ok(Array.isArray(childTools));
  assert.ok(!childTools.includes("update_goal"));
  assert.ok(!childTools.includes("set_goal_budget"));
  // 其它工具照旧继承，过滤不能把白名单整体清空。
  assert.ok(childTools.includes("read_file"));
});
