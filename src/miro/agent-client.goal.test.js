import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_CONTINUATION_PROMPT, GOAL_ROUND_CAP_CONTINUATION_PROMPT } from "./goal.js";
import { MiroAgentClient } from "./agent-client.js";

/**
 * 一个只替换 prompt() 的 client。
 *
 * 续跑驱动的全部逻辑都在 prompt() 之外，所以把它换成脚本化的假实现就能在不碰
 * 网络、不碰文件系统的前提下断言循环不变式——而那才是这个特性最容易出错的地方。
 */
function harness(script) {
  const client = new MiroAgentClient({
    cwd: "/work",
    settings: {},
    dependencies: { modelsFile: null, oauthModels: { getModels: () => [] }, loadSkills: () => ({ skills: [], diagnostics: [] }) },
  });

  const inputs = [];
  let call = 0;
  client.prompt = async (input) => {
    inputs.push(input);
    // 硬上限：脚本耗尽后 harness 会重放最后一步，一个终止条件写错的用例就会
    // 无限投递并把测试进程挂死（那是看不出原因的失败）。抛错能让同一个缺陷
    // 变成一条指名道姓的断言失败。
    if (call >= 50) throw new Error(`goal loop did not terminate after ${call} turns`);
    const step = script[Math.min(call, script.length - 1)];
    call += 1;
    // 每一步可以操作目标状态，模拟模型在回合中调用 update_goal。
    if (typeof step?.act === "function") step.act(client);
    if (step?.throws) throw step.throws;
    return { stopReason: step?.stopReason ?? "end_turn" };
  };

  return { client, inputs, calls: () => call };
}

test("a goal keeps running turns until the model marks it complete", async () => {
  const { client, inputs } = harness([
    { stopReason: "end_turn" },
    { stopReason: "end_turn" },
    { stopReason: "end_turn", act: (c) => c.goal.markComplete("done") },
  ]);

  const result = await client.promptGoal("ship the migration");

  assert.equal(inputs.length, 3);
  // 首轮发目标原文，否则模型读到「继续推进目标」却看不到目标是什么。
  assert.equal(inputs[0], "ship the migration");
  assert.equal(inputs[1], GOAL_CONTINUATION_PROMPT);
  assert.equal(inputs[2], GOAL_CONTINUATION_PROMPT);
  assert.equal(result.goal.status, "complete");
  assert.equal(result.goal.turnsUsed, 3);
});

test("a pending goal does not run until the handoff explicitly activates it", async () => {
  const { client, inputs } = harness([
    { stopReason: "end_turn", act: (c) => c.goal.markComplete("done") },
  ]);
  client.createPendingGoal("take over");
  assert.equal(client.goal.get().status, "pending");
  assert.equal(inputs.length, 0);

  const result = await client.activatePendingGoal();
  assert.equal(inputs[0], "take over");
  assert.equal(result.goal.status, "complete");
});

test("a goal blocked by the model stops immediately", async () => {
  const { client, inputs } = harness([
    { stopReason: "end_turn", act: (c) => c.goal.markBlocked("needs credentials") },
  ]);

  const result = await client.promptGoal("do the impossible");

  assert.equal(inputs.length, 1);
  assert.equal(result.goal.status, "blocked");
});

test("an interrupted turn pauses the goal instead of blocking it", async () => {
  const { client, inputs } = harness([{ stopReason: "cancelled" }]);

  const result = await client.promptGoal("long job");

  assert.equal(inputs.length, 1);
  // 中断不是受阻：目标保留为 paused，随时可以恢复。
  assert.equal(result.goal.status, "paused");
  assert.match(result.goal.terminalReason, /interruption/);
});

test("a request failure pauses the goal and rethrows", async () => {
  const boom = new Error("rate limited");
  const { client } = harness([{ throws: boom }]);

  await assert.rejects(() => client.promptGoal("x"), /rate limited/);

  // 外部故障映射成 paused：修好之后 /goal resume 就该能接着跑。
  assert.equal(client.goal.get().status, "paused");
  assert.match(client.goal.get().terminalReason, /rate limited/);
});

test("hitting the tool-round cap continues with the round-cap prompt", async () => {
  const { client, inputs } = harness([
    { stopReason: "max_turns" },
    { stopReason: "end_turn", act: (c) => c.goal.markComplete() },
  ]);

  await client.promptGoal("big job");

  // 撞满工具轮次不是做完了：续跑提示必须点明并要求把切片收小。
  assert.equal(inputs[1], GOAL_ROUND_CAP_CONTINUATION_PROMPT);
});

test("a turn budget blocks the goal and stops the loop", async () => {
  const { client, inputs } = harness([{ stopReason: "end_turn" }]);
  client.goal.create({ objective: "x" });
  client.goal.setBudgetLimits({ turnBudget: 2 });

  const result = await client.driveGoal("go");

  // 回合在开跑前计数，所以第 2 轮跑完就触顶，不会有第 3 轮。
  assert.equal(inputs.length, 2);
  assert.equal(result.goal.status, "blocked");
  assert.match(result.goal.terminalReason, /budget/);
});

test("cancelling the client stops an in-flight continuation loop", async () => {
  const { client, inputs } = harness([
    { stopReason: "end_turn", act: (c) => c.cancel() },
    { stopReason: "end_turn" },
  ]);

  await client.promptGoal("x");

  // cancel() 作废了这次运行；循环回来必须认出自己已经过期，不再投递。
  assert.equal(inputs.length, 1);
});

test("replacing the goal mid-run abandons the old loop", async () => {
  const { client, inputs } = harness([
    {
      stopReason: "end_turn",
      act: (c) => {
        c.interruptGoalRun();
        c.goal.create({ objective: "new goal", replace: true });
      },
    },
    { stopReason: "end_turn" },
  ]);

  await client.promptGoal("old goal");

  // 旧循环绝不能继续往新目标上跑回合：那会让两条运行共用一个 messages 数组。
  assert.equal(inputs.length, 1);
  assert.equal(client.goal.get().objective, "new goal");
});

test("only one continuation is in flight at a time", async () => {
  let concurrent = 0;
  let peak = 0;
  const { client } = harness([
    { stopReason: "end_turn" },
    { stopReason: "end_turn" },
    { stopReason: "end_turn", act: (c) => c.goal.markComplete() },
  ]);

  const scripted = client.prompt;
  client.prompt = async (input) => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const result = await scripted(input);
    concurrent -= 1;
    return result;
  };

  await client.promptGoal("x");

  // 并发投递会让两条 prompt() 往同一个 messages 数组里写，消息顺序直接错乱。
  assert.equal(peak, 1);
});

test("the driver safety valve pauses a goal that never finishes", async () => {
  const { client, inputs } = harness([{ stopReason: "end_turn" }]);

  const result = await client.promptGoal("endless", { maxTurns: 4 });

  assert.equal(inputs.length, 4);
  assert.equal(result.goal.status, "paused");
  assert.match(result.goal.terminalReason, /driver limit/);
});

test("resumeGoal continues the existing goal without resetting its accounting", async () => {
  const { client, inputs } = harness([
    { stopReason: "end_turn", act: (c) => c.goal.markComplete() },
  ]);
  client.goal.create({ objective: "x" });
  client.goal.countTurn();
  client.goal.countTurn();
  client.pauseGoal("interrupted");

  const result = await client.resumeGoal();

  assert.equal(inputs[0], GOAL_CONTINUATION_PROMPT);
  // 恢复是「继续」而不是「重开」：已用回合数必须累加而不是归零。
  assert.equal(result.goal.turnsUsed, 3);
  assert.equal(result.goal.status, "complete");
});

// 标题里的「停下」由 goalRunId 递增保证：续跑循环从 await prompt() 回来后发现版本
// 变了就不再投递下一轮（见 cancel 的注释）。这里钉住两个公开入口都走了这条路。
test("pauseGoal and cancelGoal invalidate the running continuation loop", async () => {
  const { client } = harness([{ stopReason: "end_turn" }]);
  client.goal.create({ objective: "x" });

  const before = client.goalRunId;
  client.pauseGoal();
  assert.ok(client.goalRunId > before);
  assert.equal(client.goal.get().status, "paused");

  const afterPause = client.goalRunId;
  client.cancelGoal();
  assert.ok(client.goalRunId > afterPause);
  assert.equal(client.goalSnapshot(), null);
});
